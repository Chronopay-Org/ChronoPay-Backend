import { Router, type Request, type Response } from "express";
import { populateAdminActor, requireAdminToken } from "../middleware/authorization.js";
import { requireFreshMfa } from "../middleware/requireFreshMfa.js";
import { requireAuthenticatedActor } from "../middleware/auth.js";
import { defaultAuditLogger } from "../services/auditLogger.js";

import { _settlements } from "../services/settlementReconciler.js";
import { getPayoutQuarantineService } from "../services/quarantineStore.js";
import gdprDsrRouter, { setDsrSlaService } from "./adminGdprDsr.js";
import accessReviewRouter from "./adminAccessReview.js";
import cancellationOverridesRouter from "./adminCancellationOverrides.js";
import adminAuditExportRouter from "./adminAuditExport.js";
import adminRefundsRouter from "./adminRefunds.js";
import adminPaymentReversalsRouter, {
  setCancellationReversalService,
  setReversalTenantPausedResolver,
} from "./adminPaymentReversals.js";
import adminFraudHitlRouter from "./adminFraudHitl.js";
import adminDisputesRouter, { getDisputes, resetDisputesState } from "./adminDisputes.js";
import adminTimezoneDriftRouter from "./adminTimezoneDrift.js";
import adminPayoutDlqRouter from "./adminPayoutDlq.js";
import adminEscrowDriftRouter, { setDriftReconciler } from "./adminEscrowDrift.js";
import adminHolidayCalendarsRouter, {
  setHolidayCalendarRepository,
} from "./adminHolidayCalendars.js";
import adminStrikesRouter from "./adminStrikes.js";
import { getImpersonationSessionStore } from "../services/impersonationSessionStore.js";
import type { SessionListOptions } from "../types/impersonation.types.js";

export {
  getDisputes,
  resetDisputesState,
  setCancellationReversalService,
  setDriftReconciler,
  setDsrSlaService,
  setHolidayCalendarRepository,
  setReversalTenantPausedResolver,
};

const router = Router();

// GDPR DSR SLA and SOC2 access-review endpoints. Mounted as sub-routers so
// their HTTP edges (validation + error mapping) stay out of this large module.
router.use(gdprDsrRouter);
router.use(accessReviewRouter);
router.use(cancellationOverridesRouter);
// --- Pending Payout Replays State ---
export type PendingReplay = {
  transactionId: string;
  initiatorId: string;
  reason: string;
  expiresAt: number;
};
export const pendingReplays = new Map<string, PendingReplay>();

function getActorIp(req: Request): string {
  const rawIp = req.ip?.replace("::ffff:", "") ?? req.socket?.remoteAddress?.replace("::ffff:", "") ?? "127.0.0.1";
  return rawIp || "127.0.0.1";
}

router.use(adminAuditExportRouter);

/**
 * @route POST /api/v1/admin/webhooks/rotate
 * @desc Promote the NEXT webhook secret to CURRENT and move the previous CURRENT to PREVIOUS.
 * @header x-chronopay-mfa — fresh MFA challenge token (from POST /api/v1/auth/mfa/verify).
 *       401 when missing/expired, 403 when bound to a different subject.
 * @access Private (admin token + MFA step-up)
 */
/**
 * @openapi
 * /api/v1/admin/webhooks/rotate:
 *   post:
 *     summary: Rotate the settlement webhook secret
 *     description: >
 *       Promotes the NEXT webhook secret to CURRENT and moves the previous
 *       CURRENT to PREVIOUS. Requires admin token authentication plus a
 *       fresh MFA step-up challenge (subject bound to the caller, default
 *       freshness 15 minutes).
 *     tags: [Admin]
 *     security:
 *       - adminTokenAuth: []
 *     parameters:
 *       - in: header
 *         name: x-chronopay-mfa
 *         required: true
 *         schema:
 *           type: string
 *         description: >
 *           Fresh MFA challenge token from POST /api/v1/auth/mfa/verify.
 *           401 when missing or older than the freshness window, 403 when
 *           issued for a different subject.
 *     responses:
 *       200:
 *         description: Secret rotated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *       401:
 *         description: Missing admin token, or missing/expired MFA challenge
 *       403:
 *         description: Invalid admin token, or MFA challenge for another subject
 */
router.post("/webhooks/rotate", requireAdminToken, populateAdminActor, requireFreshMfa(), (req: Request, res: Response) => {
  const next = process.env.SETTLEMENTS_WEBHOOK_SECRET_NEXT;
  if (!next) {
    return res.status(400).json({ success: false, error: "No NEXT webhook secret configured" });
  }

  const oldCurrent = process.env.SETTLEMENTS_WEBHOOK_SECRET;
  if (oldCurrent) {
    process.env.SETTLEMENTS_WEBHOOK_SECRET_PREVIOUS = oldCurrent;
  }

  process.env.SETTLEMENTS_WEBHOOK_SECRET = next;
  delete process.env.SETTLEMENTS_WEBHOOK_SECRET_NEXT;

  return res.status(200).json({ success: true });
});

router.use(adminRefundsRouter);

router.use(adminPaymentReversalsRouter);

router.get(
  "/payouts/quarantine",
  requireAuthenticatedActor(["admin"]),
  async (_req: Request, res: Response, next) => {
    try {
      const entries = await getPayoutQuarantineService().list();
      return res.json({ success: true, entries });
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  "/payouts/:payoutId/quarantine/release",
  requireAuthenticatedActor(["admin"]),
  async (req: Request, res: Response, next) => {
    try {
      const { payoutId } = req.params;
      const { reason } = req.body ?? {};
      const releasedBy = req.auth?.userId;
      const released = await getPayoutQuarantineService().release(payoutId, {
        releasedBy,
        reason,
      });
      if (!released) {
        return res
          .status(404)
          .json({ success: false, error: "Quarantined payout not found" });
      }

      return res.json({ success: true, released: true });
    } catch (error) {
      return next(error);
    }
  }
);

// ----------------------------------------
/**
 * @route POST /api/v1/admin/payouts/:transactionId/replay
 * @desc Initiate a replay of a failed supplier payout. Requires a reason and subsequent approval from a different admin.
 * @access Private (admin role required)
 */
router.post(
  "/payouts/:transactionId/replay",
  requireAuthenticatedActor(["admin"]),
  (req: Request, res: Response) => {
    const { transactionId } = req.params;
    const { reason } = req.body;
    const initiatorId = req.auth?.userId;

    if (!initiatorId) {
      return res.status(401).json({ success: false, error: "Missing admin identity" });
    }

    if (!reason || typeof reason !== "string" || reason.trim() === "") {
      return res.status(400).json({ success: false, error: "A valid reason must be provided for the replay" });
    }

    const settlement = _settlements.get(transactionId);
    if (!settlement) {
      return res.status(404).json({ success: false, error: "Settlement not found" });
    }

    if (settlement.status !== "failed") {
      return res.status(400).json({ success: false, error: "Only failed settlements can be replayed" });
    }

    const TTL_MS = 15 * 60 * 1000; // 15 minutes
    const expiresAt = Date.now() + TTL_MS;

    const pendingRequest: PendingReplay = {
      transactionId,
      initiatorId,
      reason,
      expiresAt,
    };

    pendingReplays.set(transactionId, pendingRequest);

    defaultAuditLogger.log(
      "payout.replay_initiated",
      {
        context: { transactionId, initiatorId, reason, expiresAt },
      },
      {
        actorIp: getActorIp(req),
        resource: req.originalUrl,
        status: 202,
      }
    );

    return res.status(202).json({
      success: true,
      message: "Replay initiated. Awaiting approval from a different admin.",
      pendingRequest,
    });
  }
);

/**
 * @route POST /api/v1/admin/payouts/:transactionId/replay/approve
 * @desc Approve a pending replay request for a failed supplier payout. Must be a different admin.
 * @header x-chronopay-mfa — fresh MFA challenge token (from POST /api/v1/auth/mfa/verify).
 *       401 when missing/expired, 403 when bound to a different subject.
 * @access Private (admin role + MFA step-up)
 */
/**
 * @openapi
 * /api/v1/admin/payouts/{transactionId}/replay/approve:
 *   post:
 *     summary: Approve a pending payout replay
 *     description: >
 *       Approves a pending replay request for a failed supplier payout. The
 *       approver must be a different admin from the initiator. Requires a
 *       fresh MFA step-up challenge bound to the approving admin.
 *     tags: [Admin]
 *     security:
 *       - chronoPayAuth: []
 *     parameters:
 *       - in: path
 *         name: transactionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: header
 *         name: x-chronopay-mfa
 *         required: true
 *         schema:
 *           type: string
 *         description: >
 *           Fresh MFA challenge token from POST /api/v1/auth/mfa/verify.
 *           401 when missing or older than the freshness window, 403 when
 *           issued for a different subject.
 *     responses:
 *       200:
 *         description: Replay approved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *       401:
 *         description: Missing identity, or missing/expired MFA challenge
 *       403:
 *         description: MFA challenge for another subject, or same-admin approval
 */
router.post(
  "/payouts/:transactionId/replay/approve",
  requireAuthenticatedActor(["admin"]),
  requireFreshMfa(),
  (req: Request, res: Response) => {
    const { transactionId } = req.params;
    const approverId = req.auth?.userId;

    if (!approverId) {
      return res.status(401).json({ success: false, error: "Missing admin identity" });
    }

    const pendingRequest = pendingReplays.get(transactionId);
    if (!pendingRequest) {
      return res.status(404).json({ success: false, error: "No pending replay request found for this transaction" });
    }

    // TTL check
    if (Date.now() > pendingRequest.expiresAt) {
      pendingReplays.delete(transactionId);
      return res.status(400).json({ success: false, error: "Pending replay request has expired" });
    }

    // Dual-admin check
    if (approverId === pendingRequest.initiatorId) {
      return res.status(403).json({ success: false, error: "Approver must be a different admin from the initiator" });
    }

    const settlement = _settlements.get(transactionId);
    if (!settlement) {
      // Very unlikely edge case, but check anyway
      return res.status(404).json({ success: false, error: "Settlement not found" });
    }

    // Reset settlement state to allow reconciler to retry
    settlement.status = "pending_finality";
    settlement.attempts = 0;
    settlement.lastPolledAt = undefined;
    
    // Clear pending request
    pendingReplays.delete(transactionId);

    // Audit dual-admin action
    defaultAuditLogger.log(
      "payout.replay_approved",
      {
        context: {
          transactionId,
          initiatorId: pendingRequest.initiatorId,
          approverId,
          reason: pendingRequest.reason,
        },
      },
      {
        actorIp: getActorIp(req),
        resource: req.originalUrl,
        status: 200,
      }
    );

    return res.status(200).json({
      success: true,
      message: "Replay approved. Settlement reset to pending_finality.",
      settlement,
    });
  }
);

router.use(adminFraudHitlRouter);

/**
 * @route POST /api/v1/admin/escrow/pause
 * @desc Admin endpoint to toggle escrow paused state during migration.
 * @header x-chronopay-mfa — fresh MFA challenge token (from POST /api/v1/auth/mfa/verify).
 *       401 when missing/expired, 403 when bound to a different subject.
 * @access Private (admin role + MFA step-up)
 */
/**
 * @openapi
 * /api/v1/admin/escrow/pause:
 *   post:
 *     summary: Pause or unpause escrow holds
 *     description: >
 *       Toggles the escrow paused state during migration. Requires a fresh
 *       MFA step-up challenge bound to the authenticated admin.
 *     tags: [Admin]
 *     security:
 *       - chronoPayAuth: []
 *     parameters:
 *       - in: header
 *         name: x-chronopay-mfa
 *         required: true
 *         schema:
 *           type: string
 *         description: >
 *           Fresh MFA challenge token from POST /api/v1/auth/mfa/verify.
 *           401 when missing or older than the freshness window, 403 when
 *           issued for a different subject.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [paused]
 *             properties:
 *               paused:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Escrow pause state updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 paused:
 *                   type: boolean
 *       401:
 *         description: Missing identity, or missing/expired MFA challenge
 *       403:
 *         description: MFA challenge issued for a different subject
 */
router.post("/escrow/pause", requireAuthenticatedActor(["admin"]), requireFreshMfa(), (req: Request, res: Response) => {
  const { paused } = req.body;
  if (typeof paused !== "boolean") {
    return res.status(400).json({ success: false, error: "paused must be a boolean" });
  }

  // Assuming scheduling service is somehow accessible or we use the global state
  // Let's create an escrowMigrationState singleton and use it here.
  import("../services/escrowMigrationState.js").then(({ escrowMigrationState }) => {
    escrowMigrationState.setPaused(paused);
    res.json({ success: true, paused: escrowMigrationState.isPaused() });
  }).catch(err => {
    res.status(500).json({ success: false, error: err.message });
  });
});

/**
 * @route GET /api/v1/admin/impersonation/sessions
 * @desc List impersonation sessions with optional filters.
 *   Query params:
 *     targetUserId  – filter by impersonated user
 *     adminId       – filter by the admin who performed the impersonation
 *     since         – ISO 8601 lower-bound for startedAt
 *     limit         – max results (default 50, max 200)
 *     offset        – pagination offset (default 0)
 * @access Private (admin token only)
 */

router.get(
  "/impersonation/sessions",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const opts: SessionListOptions = {};
      const store = getImpersonationSessionStore();
      const sessions = await store.listSessions(opts);

      return res.status(200).json({ success: true, sessions });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message ?? "Failed to list impersonation sessions" });
    }
  },
);

router.use(adminDisputesRouter);

router.use(adminTimezoneDriftRouter);

router.use(adminPayoutDlqRouter);

router.use(adminEscrowDriftRouter);

router.use(adminHolidayCalendarsRouter);

router.use(adminStrikesRouter);

export default router;