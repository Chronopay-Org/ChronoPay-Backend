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
 *   5. queues borderline scores (threshold - 1) for HITL review,
 *   6. steps up on high scores — challenge response in challenge mode, or a
 *      quarantine entry in quarantine mode — instead of silently dropping.
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

declare global {
  namespace Express {
    interface Request {
      /** Anti-fraud evaluation result for the current request, when screened. */
      fraudResult?: FraudEvaluationResult;
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

export function antiFraudScoring(options: FraudScoringOptions = {}) {
  const scorer = options.scorer ?? new FraudScorer();
  const auditLogger = options.auditLogger ?? defaultAuditLogger;
  const quarantineStore = options.quarantineStore ?? new QuarantineStore();

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
        const challengeToken = crypto.randomUUID();
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

    // Borderline risk -> HITL review queue. The intent is still created by the
    // route; a human reviews the queued item.
    if (result.score === threshold - 1 && result.score > 0) {
      fraudReviewQueue.enqueue("temp-intent-id", result.score, result.reasons);
    }

    next();
  };
}
