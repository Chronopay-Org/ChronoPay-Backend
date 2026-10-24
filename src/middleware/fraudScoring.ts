/**
 * @file src/middleware/fraudScoring.ts
 *
 * Anti-fraud screening wall for booking-intent creation.
 *
 * The middleware is mounted on POST /api/v1/booking-intents (after auth,
 * validation, idempotency, rate-limiting and audit). It:
 *
 *   1. runs the {@link FraudScorer} against the request,
 *   2. attaches the scoring result to `req.fraudResult` (and the decision to
 *      `req.fraudDecision`) for downstream consumers and observability,
 *   3. records the score into the fraud drift detector,
 *   4. emits a `fraud_score` audit event for *every* evaluated intent with the
 *      final HTTP status,
 *   5. marks borderline scores (threshold - 1) for HITL review — the route
 *      queues the item via {@link enqueueHitlReviewForIntent} once the real
 *      intent id exists,
 *   6. steps up on high scores — challenge response in challenge mode (token
 *      persisted so a retry carrying `x-fraud-challenge` plus fresh MFA passes
 *      exactly once), or a quarantine entry in quarantine mode — instead of
 *      silently dropping.
 *
 * Failure semantics are explicit: if the scorer throws (e.g. a broken rule or
 * misconfigured model), the request FAILS CLOSED with a 500 so that an
 * unscored intent can never pass through the wall to the creation path.
 */

import type { NextFunction, Request, Response } from "express";
import { FraudScorer, type FraudEvaluationResult } from "../services/fraudScorer.js";
import { recordFraudScore } from "../metrics/fraudDriftMetrics.js";
import { QuarantineStore } from "../services/quarantineStore.js";
import { fraudReviewQueue, type HitlReviewItem } from "../services/fraudReviewQueue.js";
import {
  hashFraudChallengeBody,
  InMemoryFraudChallengeStore,
  type FraudChallengeStore,
} from "../services/fraudChallengeStore.js";
import { defaultAuditLogger, type AuditLogger } from "../services/auditLogger.js";
import {
  FraudReasonCode,
  getFraudReasonCode,
  getFraudMessage,
} from "../services/fraudReasonCodes.js";
import { assertFreshMfa } from "./requireFreshMfa.js";
import { logger } from "../utils/logger.js";

declare global {
  namespace Express {
    interface Request {
      /** Anti-fraud evaluation result for the current request, when screened. */
      fraudResult?: FraudEvaluationResult;
      /** Final anti-fraud decision, set once the wall has evaluated the request. */
      fraudDecision?: FraudDecision;
      /**
       * Parsed-but-unvalidated request body, captured before `validateBody`
       * strips unknown fields. Lets the anti-fraud wall inspect fields that
       * are not part of the public body contract (e.g. a client-sent email for
       * disposable-domain detection) without expanding that contract.
       */
      rawParsedBody?: unknown;
    }
  }
}

export interface FraudScoringOptions {
  /** Scorer to use; defaults to an env-configured {@link FraudScorer}. */
  scorer?: FraudScorer;
  /** Audit logger for the per-intent `fraud_score` event. */
  auditLogger?: AuditLogger;
  /** Store for quarantine entries; defaults to a fresh in-memory store. */
  quarantineStore?: QuarantineStore;
  /**
   * Store for issued step-up challenge tokens. Defaults to an in-process
   * store with TTL; inject a shared (e.g. Redis-backed) store when the wall
   * runs across multiple processes.
   */
  challengeStore?: FraudChallengeStore;
}

export type FraudDecision = "allowed" | "review" | "blocked";

/**
 * Pre-creation reference handed to the scorer (velocity bucketing, drift
 * metrics). The scorer runs before the intent exists, so it can never see the
 * real intent id — HITL items must not reuse this value (see
 * {@link enqueueHitlReviewForIntent}).
 */
function deriveIntentReference(req: Request): string {
  const body = req.body as { slotId?: string; rrule?: string } | undefined;
  return body?.slotId ?? body?.rrule ?? "temp-intent-id";
}

/** Reads a (possibly repeated) request header, trimmed; "" when absent. */
function readHeader(req: Request, name: string): string {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Preserves the parsed (but not yet validated) request body on
 * `req.rawParsedBody`. Mount before `validateBody` so anti-fraud scoring —
 * which runs later, after validation — can still read client-supplied fields
 * that the body schema would strip.
 */
export function captureRequestBody(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  req.rawParsedBody = req.body;
  next();
}

export function antiFraudScoring(options: FraudScoringOptions = {}) {
  const scorer = options.scorer ?? new FraudScorer();
  const auditLogger = options.auditLogger ?? defaultAuditLogger;
  const quarantineStore = options.quarantineStore ?? new QuarantineStore();
  const challengeStore = options.challengeStore ?? new InMemoryFraudChallengeStore();

  /**
   * Resolves a retry that presented `x-fraud-challenge` on a request the wall
   * would otherwise block:
   *
   *   1. verify a fresh MFA proof (`x-chronopay-mfa`, same semantics as
   *      `requireFreshMfa`) — done first so a presenter without MFA learns
   *      nothing about token validity and cannot burn someone else's token;
   *   2. consume the challenge token (single-use; actor- and body-bound);
   *   3. let the request through exactly once.
   *
   * On any failure the response has already been written by step 1/2 and
   * `next` is never called.
   */
  async function resolveChallengeRetry(
    req: Request,
    res: Response,
    next: NextFunction,
    challengeToken: string,
    actorId: string,
    bodyHash: string,
  ): Promise<void> {
    const mfaSatisfied = await assertFreshMfa(req, res);
    if (!mfaSatisfied) {
      return;
    }

    const verdict = challengeStore.consume(challengeToken, { actorId, bodyHash });
    if (!verdict.ok) {
      logger.warn(
        { actorId, reason: verdict.reason, resource: req.originalUrl },
        "Fraud challenge retry rejected",
      );
      res.status(403).json({
        success: false,
        error: "Fraud challenge is invalid or has expired.",
        challengeRequired: true,
      });
      return;
    }

    logger.info(
      { actorId, resource: req.originalUrl },
      "Fraud challenge satisfied; allowing one retry past the anti-fraud wall",
    );
    next();
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const intentReference = deriveIntentReference(req);

    let result: FraudEvaluationResult;
    try {
      result = scorer.evaluate(intentReference, req);
    } catch (error) {
      // Fail closed — an unavailable scorer must never let unscored intents
      // reach the creation path. The 500 is diagnostic (safe, non-leaky).
      logger.error(
        { err: error, actorId: req.auth?.userId },
        "Anti-fraud scoring failed; blocking booking-intent request",
      );
      res.status(500).json({
        success: false,
        error: "Booking intents are temporarily unavailable. Please retry.",
      });
      return;
    }

    req.fraudResult = result;

    // Feed the live score into the fraud drift detector. The metrics module is
    // import-side-effect-free so a missing baseline is a no-op. The
    // FRAUD_MODEL_VERSION env threads the histogram label through the
    // deployment env (e.g. "2025-q1-r3").
    recordFraudScore(`v${process.env.FRAUD_MODEL_VERSION || "default"}`, result.score);

    const threshold = scorer.getThreshold();
    const decision: FraudDecision =
      result.score >= threshold
        ? "blocked"
        : result.score === threshold - 1 && result.score > 0
          ? "review"
          : "allowed";
    // Published on the request so the route can act on the decision (the HITL
    // enqueue needs the created intent id, which does not exist yet here).
    req.fraudDecision = decision;

    // Emit one auditable `fraud_score` event per evaluated intent with the
    // eventual HTTP status. Fire-and-forget: audit writer failures must never
    // block the serving path.
    res.on("finish", () => {
      void auditLogger
        .log(
          "fraud_score",
          {
            method: req.method,
            body: {
              actorId: req.auth?.userId,
              score: result.score,
              threshold,
              reasons: result.reasons,
              decision,
              snapshotId: result.snapshot?.snapshotId,
              specVersion: result.snapshot?.specVersion,
            },
          },
          {
            actorIp: req.ip || req.socket?.remoteAddress,
            resource: req.originalUrl,
            status: res.statusCode,
          },
        )
        .catch(() => {});
    });

    if (result.score >= threshold) {
      const locale = req.headers["accept-language"]?.split(",")[0]?.split("-")[0] || "en";
      const publicCodes = Array.from(
        new Set(result.reasons.map((reason) => getFraudReasonCode(reason))),
      );
      if (publicCodes.length === 0) publicCodes.push(FraudReasonCode.UNKNOWN_RISK);

      const errorPayload = {
        success: false,
        error: "Booking intent blocked due to security policies.",
        reasonCodes: publicCodes,
        messages: publicCodes.map((code) => getFraudMessage(code, locale)),
      };

      if (scorer.getStepUpMode() === "challenge") {
        const presentedChallenge = readHeader(req, "x-fraud-challenge");
        if (presentedChallenge.length > 0) {
          // The client is retrying a previously blocked request with the
          // issued token plus fresh MFA proof. Only a validated, unconsumed
          // token for this actor and this exact body passes the wall once.
          void resolveChallengeRetry(
            req,
            res,
            next,
            presentedChallenge,
            req.auth?.userId ?? "",
            hashFraudChallengeBody(req.rawParsedBody ?? req.body ?? null),
          ).catch((error) => {
            logger.error(
              { err: error, actorId: req.auth?.userId },
              "Fraud challenge retry failed; failing closed",
            );
            if (!res.headersSent) {
              res.status(500).json({
                success: false,
                error: "Booking intents are temporarily unavailable. Please retry.",
              });
            }
          });
          return;
        }

        // Issue a token so the legitimate user can complete step-up (MFA) and
        // retry this exact request. Persisted: the 403 alone was previously a
        // dead end because the token existed only in the response body.
        const challengeToken = crypto.randomUUID();
        challengeStore.issue(challengeToken, {
          actorId: req.auth?.userId ?? "",
          bodyHash: hashFraudChallengeBody(req.rawParsedBody ?? req.body ?? null),
        });
        res.status(403).json({
          ...errorPayload,
          challengeRequired: true,
          challengeToken,
        });
      } else {
        const quarantineId = quarantineStore.add({
          input: req.body,
          actorId: req.auth?.userId,
          fraudResult: result,
        });
        res.status(403).json({
          ...errorPayload,
          quarantineId,
        });
      }
      return;
    }

    // Borderline risk (decision "review"): the intent is still created by the
    // route. The HITL item is queued there — via
    // enqueueHitlReviewForIntent(req, intent.id) — because only the route
    // knows the real intent id; enqueueing here would store the placeholder
    // "temp-intent-id" reviewers cannot act on.
    next();
  };
}

/**
 * Queues the current request's borderline score for HITL review against the
 * intent id that was actually created. Call from the route handler after the
 * intent has been created (per created intent when a request yields several).
 * No-op unless the anti-fraud wall decided "review" for this request.
 */
export function enqueueHitlReviewForIntent(
  req: Request,
  intentId: string,
): HitlReviewItem | undefined {
  if (req.fraudDecision !== "review" || !req.fraudResult || !intentId) {
    return undefined;
  }
  return fraudReviewQueue.enqueue(intentId, req.fraudResult.score, req.fraudResult.reasons);
}
