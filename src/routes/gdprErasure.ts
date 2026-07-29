/**
 * gdprErasure.ts — POST /api/v1/gdpr/erase
 *
 * Exposes the GDPR erasure orchestrator as an HTTP endpoint.
 *
 * ## Security
 *
 * - Requires `x-chronopay-user-id` + `x-chronopay-role` headers.
 * - Only `admin` role may trigger live erasure.
 * - `auditor` role may use `dryRun: true` only; live erasure returns 403.
 *
 * ## Request body
 *
 * ```json
 * { "subjectId": "<uuid>", "dryRun": false }
 * ```
 *
 * `dryRun` defaults to `false`.
 *
 * ## Response (200 OK)
 *
 * ```json
 * {
 *   "success": true,
 *   "receipt": { ... },
 *   "plan": [ ... ]   // only present when dryRun is true
 * }
 * ```
 *
 * ## Error responses
 *
 * | Status | Reason                                              |
 * |--------|-----------------------------------------------------|
 * | 400    | Missing or invalid `subjectId`                      |
 * | 403    | Auditor attempting a live erasure                   |
 * | 409    | Subject is under a legal hold                       |
 * | 500    | Unexpected server error                             |
 */

import { Router, type Request, type Response } from "express";
import { requireAuthenticatedActor } from "../middleware/auth.js";
import { createAuthAwareRateLimiter } from "../middleware/rateLimiter.js";
import {
  GdprErasureOrchestrator,
  LegalHoldViolationError,
} from "../services/gdprErasure/GdprErasureOrchestrator.js";
import type { ErasureEventLog } from "../services/gdprErasure/eventLog.js";
import type { DbPool, LegalHoldChecker } from "../services/gdprErasure/GdprErasureOrchestrator.js";
import { AuditLogger } from "../services/auditLogger.js";

export interface GdprErasureRouterOptions {
  /** Override for testing — replaces the real DB pool. */
  pool?: DbPool;
  /** Override for testing — replaces the real legal-hold checker. */
  legalHold?: LegalHoldChecker;
  /** Override for testing — replaces the real audit logger. */
  auditLogger?: AuditLogger;
  /** Override for testing — replaces the real event log. */
  eventLog?: ErasureEventLog;
}

/**
 * Factory that creates the erasure router with optional injected dependencies.
 */
export function createGdprErasureRouter(opts?: GdprErasureRouterOptions): Router {
  const router = Router();
  const orchestrator = new GdprErasureOrchestrator({
    pool: opts?.pool,
    legalHold: opts?.legalHold,
    auditLogger: opts?.auditLogger,
    eventLog: opts?.eventLog,
  });

  /**
   * POST /
   *
   * Erase (or dry-run preview) PII for the given `subjectId`.
   * Access: admin (live + dry-run), auditor (dry-run only).
   */
  router.post(
    "/",
    requireAuthenticatedActor(["admin", "auditor"]),
    createAuthAwareRateLimiter(),
    async (req: Request, res: Response) => {
      try {
        const { subjectId, dryRun = false } = req.body as {
          subjectId?: unknown;
          dryRun?: unknown;
        };

        // ── Input validation ──────────────────────────────────────────────────
        if (!subjectId || typeof subjectId !== "string" || !subjectId.trim()) {
          return res.status(400).json({
            success: false,
            error: "subjectId is required and must be a non-empty string.",
          });
        }

        const isDryRun = dryRun === true || dryRun === "true";

        // ── Role enforcement ──────────────────────────────────────────────────
        // Auditors may only use dry-run mode.
        const actorRole = req.auth?.role;
        if (actorRole === "auditor" && !isDryRun) {
          return res.status(403).json({
            success: false,
            error: "Auditors may only perform dry-run erasure previews.",
          });
        }

        const requestedBy = req.auth?.userId ?? "unknown";

        const result = await orchestrator.erase({
          subjectId: subjectId.trim(),
          requestedBy,
          dryRun: isDryRun,
        });

        const responseBody: Record<string, unknown> = {
          success: true,
          receipt: result.receipt,
        };

        // Include the action plan in dry-run responses for auditor review.
        if (isDryRun) {
          responseBody.plan = result.tableResults.map((t) => ({
            table: t.table,
            plannedActions: t.actions,
          }));
        }

        return res.status(200).json(responseBody);
      } catch (error) {
        if (error instanceof LegalHoldViolationError) {
          return res.status(409).json({
            success: false,
            error: error.message,
            code: "LEGAL_HOLD",
          });
        }

        const message = error instanceof Error ? error.message : "Erasure failed";
        return res.status(500).json({ success: false, error: message });
      }
    },
  );

  return router;
}

/** Default router instance (uses real DB + real services). */
export const gdprErasureRouter = createGdprErasureRouter();
