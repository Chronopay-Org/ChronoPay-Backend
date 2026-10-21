/**
 * @file src/middleware/fraudScoring.ts
 *
 * Anti-fraud screening wall for booking-intent creation.
 *
 * The middleware is mounted on POST /api/v1/booking-intents (after auth,
 * validation, idempotency, rate-limiting and audit). It:
 *
 *   1. runs the {@link FraudScorer} against the request,
 *   2. attaches the scoring result to `req.fraudResult` for downstream
 *      consumers and observability,
 *   3. records the score into the fraud drift detector,
 *   4. emits a `fraud_score` audit event for *every* evaluated intent with the
 *      final HTTP status,
 *   5. defers borderline scores (threshold - 1) to the HITL review queue: the
 *      review item is created by the route handler once the intent exists, so
 *      it can carry the real intent id (issue #1345),
 *   6. steps up on high scores — challenge response in challenge mode, or a
 *      quarantine entry in quarantine mode — instead of silently dropping.
 *
 * Challenge mode issues a one-time `challengeToken` (persisted in
 * {@link FraudChallengeStore}, bound to the actor and the request body). A
 * blocked client retries the identical request with the token in the
 * `x-fraud-challenge` header *and* a fresh MFA proof in `x-chronopay-mfa`; the
 * block is then bypassed exactly once and any reuse of the token is rejected
 * (issue #1345).
 *
 * Failure semantics are explicit: if the scorer throws (e.g. a broken rule or
 * misconfigured model), the request FAILS CLOSED with a 500 so that an
 * unscored intent can never pass through the wall to the creation path.
 */

import type { NextFunction, Request, Response } from "express";
import { FraudScorer, type FraudEvaluationResult } from "../services/fraudScorer.js";
import { recordFraudScore } from "../metrics/fraudDriftMetrics.js";
import { QuarantineStore } from "../services/quarantineStore.js";
import { fraudReviewQueue } from "../services/fraudReviewQueue.js";
import { defaultAuditLogger, type AuditLogger } from "../services/auditLogger.js";
import {
  FraudReasonCode,
  getFraudReasonCode,
  getFraudMessage,
} from "../services/fraudReasonCodes.js";
import { logger } from "../utils/logger.js";
import {
  FraudChallengeStore,
  fraudChallengeStore,
  hashRequestBody,
  type FraudChallengeRejection,
} from "../services/fraudChallengeStore.js";
import {
  verifyRequestMfaChallenge,
  type RequireFreshMfaOptions,
} from "./requireFreshMfa.js";

declare global {
  namespace Express {
    interface Request {
      /** Anti-fraud evaluation result for the current request, when screened. */
      fraudResult?: FraudEvaluationResult;
      /**
       * Borderline (threshold - 1) evaluation awaiting a HITL review item.
       * Set by the anti-fraud wall; the route handler reports the created
       * intent id(s) via {@link enqueuePendingFraudReviews} so the queued item
       * is bound to a real intent instead of a placeholder (issue #1345).
       */
      fraudReview?: { score: number; reasons: string[] };
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
  /** Store for challenge tokens; defaults to the process-wide store. */
  challengeStore?: FraudChallengeStore;
  /** MFA options used to verify the step-up proof on a challenge retry. */
  mfa?: RequireFreshMfaOptions;
}

type FraudDecision = "allowed" | "review" | "blocked";

function deriveIntentReference(req: Request): string {
  const body = req.body as { slotId?: string; rrule?: string } | undefined;
  return body?.slotId ?? body?.rrule ?? "temp-intent-id";
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

function readHeader(req: Request, name: string): string {
  const raw = req.headers[name];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return typeof header === "string" ? header.trim() : "";
}

const FRAUD_CHALLENGE_REJECTIONS: Record<FraudChallengeRejection, string> = {
  unknown: "Fraud challenge token is not valid.",
  expired: "Fraud challenge token has expired; please retry to obtain a new one.",
  actor_mismatch: "Fraud challenge token does not match this request.",
  body_mismatch: "Fraud challenge token does not match this request.",
};

/**
 * Reports the HITL review the anti-fraud wall deferred for `req` (borderline
 * score), binding it to the intent id(s) the route actually created. Called by
 * the route handler after creation so a review item never points at a
 * placeholder id (issue #1345). A no-op when the score was not borderline or
 * no intent was created.
 */
export function enqueuePendingFraudReviews(
  req: Request,
  intentIds: readonly string[],
): void {
  const pending = req.fraudReview;
  if (!pending) {
    return;
  }
  for (const intentId of intentIds) {
    fraudReviewQueue.enqueue(intentId, pending.score, pending.reasons);
  }
}

export function antiFraudScoring(options: FraudScoringOptions = {}) {
  const scorer = options.scorer ?? new FraudScorer();
  const auditLogger = options.auditLogger ?? defaultAuditLogger;
  const quarantineStore = options.quarantineStore ?? new QuarantineStore();
  const challengeStore = options.challengeStore ?? fraudChallengeStore;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // A blocked client may retry with the one-time challenge token it was
    // issued plus a fresh MFA proof. Both are verified before the block is
    // bypassed; the token is consumed so it can never be reused.
    const challengeToken = readHeader(req, "x-fraud-challenge");
    let challengeBypassed = false;
    if (challengeToken.length > 0) {
      const actorId = req.auth?.userId ?? "";
      const bodyHash = hashRequestBody(req.rawParsedBody ?? req.body);
      const rejection = challengeStore.check(challengeToken, actorId, bodyHash);
      if (rejection) {
        res.status(403).json({
          success: false,
          error: FRAUD_CHALLENGE_REJECTIONS[rejection],
        });
        return;
      }

      const mfa = await verifyRequestMfaChallenge(req, options.mfa ?? {});
      if (!mfa.ok) {
        // The token stays redeemable: only a solved challenge consumes it.
        res.status(mfa.status).json({ success: false, error: mfa.error });
        return;
      }
      if (!challengeStore.consume(challengeToken)) {
        res.status(403).json({
          success: false,
          error: FRAUD_CHALLENGE_REJECTIONS.unknown,
        });
        return;
      }
      challengeBypassed = true;
    }

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
    const borderline = result.score === threshold - 1 && result.score > 0;
    const decision: FraudDecision =
      result.score >= threshold
        ? challengeBypassed
          ? "allowed"
          : "blocked"
        : borderline
          ? "review"
          : "allowed";

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

    // A solved step-up challenge bypasses the block exactly once; otherwise a
    // high score steps the request up instead of dropping it.
    if (result.score >= threshold && !challengeBypassed) {
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
        // Persist the token so the retry can be verified (issue #1345). It is
        // bound to this actor and this request body, and expires on a TTL.
        const { token: issuedToken } = challengeStore.issue(
          req.auth?.userId ?? "",
          hashRequestBody(req.rawParsedBody ?? req.body),
        );
        res.status(403).json({
          ...errorPayload,
          challengeRequired: true,
          challengeToken: issuedToken,
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

    // Borderline risk -> deferred HITL review. The intent is still created by
    // the route, which reports the real intent id(s) back through
    // `enqueuePendingFraudReviews` so the queued item is actionable (the
    // middleware cannot know the id before creation).
    if (borderline) {
      req.fraudReview = { score: result.score, reasons: result.reasons };
    }

    next();
  };
}
