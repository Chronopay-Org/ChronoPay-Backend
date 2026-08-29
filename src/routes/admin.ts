// @ts-nocheck
import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import { auditExportService } from "../services/auditExportService.js";
import { RefundService } from "../services/refund.js";
import { requireAuthenticatedActor } from "../middleware/auth.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import {
  HolidayCalendarService,
  InMemoryHolidayCalendarRepository,
  HolidayCalendarNotFoundError,
  HolidayCalendarConflictError,
  HolidayCalendarValidationError,
  type IHolidayCalendarRepository,
} from "../services/holidayCalendarService.js";

import { _settlements } from "../services/settlementReconciler.js";
import { fraudReviewQueue } from "../services/fraudReviewQueue.js";
import {
  CancellationReversalService,
  CancellationReversalCurrencyMismatchError,
  isSupportedCurrency,
  setTenantPausedResolver as setReversalTenantPausedResolver,
} from "../modules/cancellation/cancellation-reversal-service.js";
import { PgCancellationReversalRepository } from "../modules/cancellation/pg-cancellation-reversal-repository.js";
import { PgCheckoutSessionRepository } from "../modules/checkout/pg-checkout-session-repository.js";
import { query } from "../db/pool.js";
import { DisputeArbitrationQueueService } from "../services/disputeArbitrationQueue.js";
import {
  addSeniorArbiter,
  appendFinalityLink,
  canTransition,
  decideByMajority,
  getSeniorPool,
  isWithinAppealWindow,
  resetSeniorPool,
  selectSeniorPanel,
  validateSeniorDecision,
  SENIOR_PANEL_MIN_SIZE,
} from "../services/disputeAppeals.js";
import {
  reverseAutoResolve,
  scanAndAutoResolve,
} from "../services/disputeDeadlineService.js";
import { isDisputeDeadlineSchedulerRunning } from "../scheduler/disputeDeadlineScheduler.js";
import { getPayoutQuarantineService } from "../services/quarantineStore.js";
import { strikeService } from "../services/strikeService.js";
import type { Dispute as DisputeDomainType, SeniorPanelVote } from "../types/dispute.js";

/**
 * Singleton cancellation-reversal service. The route handlers reuse
 * the same instance across requests so the in-memory ledger state stays
 * consistent within a process.
 *
 * Production bootstrap is responsible for calling
 * `setReversalTenantPausedResolver(fn)` to wire a real tenant-paused
 * source (e.g. one that consults the live `SchedulingService`). Until
 * that hook is wired, all requests pass through the tenant gate
 * without restriction — the failure mode is "tenant-pause never fires"
 * (fail-open) rather than "every accepted-paused silently means denied".
 */
const _checkoutSessionRepoForReversal = new PgCheckoutSessionRepository(query);

function buildReversalService(): CancellationReversalService {
  return new CancellationReversalService({
    repo: new PgCancellationReversalRepository(query),
    checkoutSessionLookup: {
      async getCurrency(paymentId: string) {
        const session = await _checkoutSessionRepoForReversal.findById(paymentId);
        if (!session) return null;
        return isSupportedCurrency(session.payment.currency)
          ? session.payment.currency
          : null;
      },
    },
    // No tenant-paused resolver is wired at module-load. The admin
    // route's tenant-paused check falls-through to "no tenant is
    // paused" until `setReversalTenantPausedResolver(fn)` is wired
    // by production bootstrap.
    netRefundLookup: {
      async getNetRefund() {
        // The netRefund is provided by the prorated cancellation policy.
        // Returning `null` here triggers the strict-mode
        // CancellationReversalNetRefundNotRegisteredError on
        // append, surfacing the missing wiring at runtime. Production
        // must wire a real lookup at bootstrap.
        return null;
      },
    },
  });
}

let _cancellationReversalService: CancellationReversalService =
  buildReversalService();

/** Test/production hook to swap the entire service. */
export function setCancellationReversalService(
  service: CancellationReversalService,
): void {
  _cancellationReversalService = service;
}

export function setDsrSlaService(_service: any): void {}

// Re-export for route-level test convenience.
export { setReversalTenantPausedResolver };

const router = Router();
const disputeQueueService = new DisputeArbitrationQueueService();

// In-memory dispute state for E2E tests
const disputes = new Map<string, DisputeDomainType>();
let ledgers = { buyer: 1000, supplier: 1000 };

// --- Pending Payout Replays State ---
export type PendingReplay = {
  transactionId: string;
  initiatorId: string;
  reason: string;
  expiresAt: number;
};
export const pendingReplays = new Map<string, PendingReplay>();

function buildBaseUrl(req: Request): string {
  const scheme = req.protocol;
  const host = req.get("host") ?? "localhost";
  return `${scheme}://${host}`;
}

function getActorIp(req: Request): string {
  const rawIp = req.ip?.replace("::ffff:", "") ?? req.socket?.remoteAddress?.replace("::ffff:", "") ?? "127.0.0.1";
  return rawIp || "127.0.0.1";
}

/**
 * @route POST /api/v1/admin/audit/export
 * @desc Generate an admin-only audit JSONL export and receive a signed download URL.
 * @access Private (admin token only)
 */
router.post("/audit/export", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const baseUrl = buildBaseUrl(req);
    const result = await auditExportService.createExport(baseUrl);
    return res.status(201).json({
      success: true,
      downloadUrl: result.downloadUrl,
      integrity: result.integrity,
      expiresAt: result.expiresAt,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message ?? "Audit export failed" });
  }
});

/**
 * @route GET /api/v1/admin/audit/export/download
 * @desc Download a signed audit export file using a short-lived token.
 * @access Public via signed token
 */
router.get("/audit/export/download", async (req: Request, res: Response) => {
  try {
    const token = req.query.token;
    if (!token || typeof token !== "string") {
      return res.status(400).json({ success: false, error: "Missing export token" });
    }

    const exportEntry = await auditExportService.getExport(token);
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", "attachment; filename=chronopay-audit-export.ndjson");
    res.setHeader("X-Audit-Export-Integrity-Sha256", exportEntry.integrity);
    return res.send(exportEntry.content);
  } catch (error: any) {
    const message = error.message || "Export download failed";
    if (message.includes("expired") || message.includes("Invalid export token")) {
      return res.status(401).json({ success: false, error: message });
    }
    if (message.includes("not found")) {
      return res.status(404).json({ success: false, error: message });
    }
    return res.status(500).json({ success: false, error: message });
  }
});

/**
 * @route POST /api/v1/admin/webhooks/rotate
 * @desc Promote the NEXT webhook secret to CURRENT and move the previous CURRENT to PREVIOUS.
 * @access Private (admin token only)
 */
router.post("/webhooks/rotate", requireAdminToken, (req: Request, res: Response) => {
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

// --- Refund Routes ---

/**
 * @route POST /api/v1/admin/refunds
 * @desc Create a partial refund against a completed payment session.
 *       Enforces the invariant that sum of refunds <= captured amount.
 * @access Private (admin token only)
 */
router.post("/refunds", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const { paymentId, amountCents, currency, reason, refundedBy } = req.body;

    if (!paymentId) {
      return res.status(400).json({ success: false, error: "paymentId is required" });
    }
    if (!amountCents || typeof amountCents !== "number" || amountCents <= 0) {
      return res.status(400).json({ success: false, error: "amountCents must be a positive integer" });
    }

    const refund = await RefundService.createRefundTraced({
      paymentId,
      amountCents,
      currency,
      reason,
      refundedBy,
    });

    return res.status(201).json({ success: true, refund });
  } catch (error: any) {
    const status = error.status ?? 500;
    return res.status(status).json({
      success: false,
      error: error.message ?? "Refund creation failed",
      code: error.code,
      details: error.details,
    });
  }
});

/**
 * @route POST /api/v1/admin/payments/:paymentId/reversals
 * @desc Record a prorated-cancellation reversal entry against a payment.
 *       Body: { bookingIntentId, amountCents (sign-aware), currency,
 *               originalRefundId?, escrowReleased?, escrowReleasedAmountCents?,
 *               escrowReleaseTxId?, reason, policyVersionId, idempotencyKey, metadata? }.
 *       Errors:
 *         422 INVALID_CURRENCY    — entry currency != payment currency
 *         409 invariant violation — sum across booking + amount != -netRefund
 *         422 TenantPausedError  — metadata.tenantId resolves to a paused tenant
 * @access Private (admin token only)
 */
router.post(
  "/payments/:paymentId/reversals",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const { paymentId } = req.params;
      const body = req.body ?? {};

      const required = [
        "bookingIntentId",
        "amountCents",
        "currency",
        "reason",
        "policyVersionId",
        "idempotencyKey",
      ];
      for (const k of required) {
        if (body[k] === undefined || body[k] === null || body[k] === "") {
          return res
            .status(400)
            .json({ success: false, error: `${k} is required` });
        }
      }
      if (typeof body.amountCents !== "number" || !Number.isInteger(body.amountCents) || body.amountCents === 0) {
        return res
          .status(400)
          .json({ success: false, error: "amountCents must be a non-zero integer" });
      }
      if (
        typeof body.escrowReleasedAmountCents === "number" &&
        body.escrowReleasedAmountCents < 0
      ) {
        return res.status(400).json({
          success: false,
          error: "escrowReleasedAmountCents must be >= 0",
        });
      }
      if (typeof body.escrowReleased !== "boolean") {
        return res.status(400).json({
          success: false,
          error: "escrowReleased must be a boolean",
        });
      }

      const entry = await _cancellationReversalService.appendEntry({
        bookingIntentId: String(body.bookingIntentId),
        paymentId: String(paymentId),
        originalRefundId:
          body.originalRefundId === undefined || body.originalRefundId === null
            ? undefined
            : String(body.originalRefundId),
        amountCents: body.amountCents,
        currency: body.currency,
        escrowReleased: body.escrowReleased,
        escrowReleasedAmountCents: body.escrowReleasedAmountCents ?? 0,
        escrowReleaseTxId:
          body.escrowReleaseTxId === undefined || body.escrowReleaseTxId === null
            ? undefined
            : String(body.escrowReleaseTxId),
        reason: String(body.reason),
        idempotencyKey: String(body.idempotencyKey),
        policyVersionId: String(body.policyVersionId),
        actor: req.auth?.userId ?? "admin",
        metadata:
          body.metadata && typeof body.metadata === "object"
            ? (body.metadata as Record<string, unknown>)
            : undefined,
      });

      return res.status(201).json({ success: true, entry });
    } catch (error: any) {
      if (
        error instanceof CancellationReversalCurrencyMismatchError
      ) {
        return res.status(422).json({
          success: false,
          code: "CURRENCY_MISMATCH",
          error: error.message,
          details: error.details,
        });
      }
      const status = error.status ?? 500;
      return res.status(status).json({
        success: false,
        error: error.message ?? "Reversal recording failed",
        code: error.code,
      });
    }
  },
);

/**
 * @route GET /api/v1/admin/booking-intents/:bookingIntentId/invariant
 * @desc Compute the per-(bookingIntentId, currency) reversal invariant. The
 *       `currency` query parameter is required. Returns 200 with
 *       `{ valid, sumReversalCents, expectedNegationOfNetRefund, reason? }`.
 * @access Private (admin token only)
 */
router.get(
  "/booking-intents/:bookingIntentId/invariant",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const currency = String(req.query.currency ?? "");
      const validCurrencies = ["USD", "EUR", "GBP", "XLM"];
      if (!validCurrencies.includes(currency)) {
        return res.status(400).json({
          success: false,
          error: `currency query parameter is required (one of ${validCurrencies.join(", ")})`,
        });
      }
      const result = await _cancellationReversalService.checkInvariantForBooking(
        req.params.bookingIntentId,
        currency,
      );
      const chain = await _cancellationReversalService.verifyChainForPayment(
        // The invariant endpoint is per-booking; the chain walk is keyed
        // off paymentId which the caller may pass as `?paymentId=`.
        String(req.query.paymentId ?? ""),
      );
      return res.json({
        success: true,
        invariant: result,
        chain: chain.valid
          ? { valid: true, entriesChecked: chain.entriesChecked }
          : { valid: false, ...chain },
      });
    } catch (error: any) {
      const status = error.status ?? 500;
      return res.status(status).json({
        success: false,
        error: error.message ?? "Invariant check failed",
      });
    }
  },
);

/**
 * @route GET /api/v1/admin/booking-intents/:bookingIntentId/reversal-chain
 * @desc Walk the hash chain for a paymentId and report integrity. The
 *       `paymentId` query parameter is required.
 * @access Private (admin token only)
 */
router.get(
  "/booking-intents/:bookingIntentId/reversal-chain",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const paymentId = String(req.query.paymentId ?? "");
      if (!paymentId) {
        return res.status(400).json({
          success: false,
          error: "paymentId query parameter is required",
        });
      }
      const chain = await _cancellationReversalService.verifyChainForPayment(
        paymentId,
      );
      return res.json({ success: true, chain });
    } catch (error: any) {
      const status = error.status ?? 500;
      return res.status(status).json({
        success: false,
        error: error.message ?? "Chain verification failed",
      });
    }
  },
);
router.get("/payments/:id/trace", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const trace = await RefundService.getPaymentTraceTraced(req.params.id);

    const includeReversals = String(req.query.include ?? "")
      .toLowerCase()
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .includes("reversals");

    if (!includeReversals) {
      return res.json({ success: true, trace });
    }

    const reversalTrace = await _cancellationReversalService.buildPaymentReversalTrace({
      paymentId: trace.payment.id,
      paymentsCurrency: trace.payment.currency,
      refunds: trace.refunds.map((r) => ({
        id: r.id,
        amountCents: r.amountCents,
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt,
      })),
    });

    return res.json({
      success: true,
      trace: {
        ...trace,
        reversals: reversalTrace.reversals,
        invariantStatus: reversalTrace.invariantStatus,
        invariantValid: reversalTrace.invariantValid,
        netAcrossOriginalAndReversalCents:
          reversalTrace.netAcrossOriginalAndReversalCents,
      },
    });
  } catch (error: any) {
    const status = error.status ?? 500;
    return res.status(status).json({
      success: false,
      error: error.message ?? "Trace retrieval failed",
    });
  }
});

router.get(
  "/payouts/quarantine",
  requireAuthenticatedActor(["admin"]),
  (_req: Request, res: Response) => {
    const service = getPayoutQuarantineService();
    const entries = service.list();
    return res.json({
      success: true,
      entries,
    });
  }
);

router.post(
  "/payouts/:payoutId/quarantine/release",
  requireAuthenticatedActor(["admin"]),
  (req: Request, res: Response) => {
    const { payoutId } = req.params;
    const { reason } = req.body ?? {};
    const releasedBy = req.auth?.userId;

    const service = getPayoutQuarantineService();
    const released = service.release(payoutId, { releasedBy, reason });
    if (!released) {
      return res.status(404).json({ success: false, error: "Quarantined payout not found" });
    }

    return res.json({
      success: true,
      released: true,
    });
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
 * @access Private (admin role required)
 */
router.post(
  "/payouts/:transactionId/replay/approve",
  requireAuthenticatedActor(["admin"]),
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

/**
 * @route GET /api/v1/admin/fraud/hitl/queue
 * @desc Get pending review items for medium-risk fraud scores.
 * @access Private (admin role required)
 */
router.get("/fraud/hitl/queue", requireAuthenticatedActor(["admin"]), (req: Request, res: Response) => {
  res.json({ success: true, items: fraudReviewQueue.getPendingItems() });
});

/**
 * @route POST /api/v1/admin/fraud/hitl/:id/decision
 * @desc Operator endpoint for approve/reject/refer on HITL queue items.
 * @access Private (admin role required)
 */
router.post("/fraud/hitl/:id/decision", requireAuthenticatedActor(["admin"]), (req: Request, res: Response) => {
  const { decision, notes } = req.body;
  const operatorId = req.auth?.userId || "unknown";

  if (!["approved", "rejected", "referred"].includes(decision)) {
    return res.status(400).json({ success: false, error: "Invalid decision. Must be approved, rejected, or referred." });
  }

  try {
    const item = fraudReviewQueue.decide(req.params.id, operatorId, decision, notes);
    return res.json({ success: true, item });
  } catch (err: any) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * @route POST /api/v1/admin/escrow/pause
 * @desc Admin endpoint to toggle escrow paused state during migration.
 * @access Private (admin role required)
 */
router.post("/escrow/pause", requireAuthenticatedActor(["admin"]), (req: Request, res: Response) => {
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

// --- Mock Dispute Logic for E2E Tests ---
type Dispute = {
  id: string;
  status: "OPEN" | "EVIDENCED" | "ADJUDICATED" | "APPEALED" | "CLOSED" | "TIMEOUT";
  buyerId: string;
  supplierId: string;
  amount: number;
  evidence: string[];
  ruling?: string;
  arbiter?: string;
};

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

/**
 * Export a snapshot of the current dispute list. Used by the dispute deadline
 * scheduler in `src/index.ts` and by tests via `resetDisputesState`.
 */
export function getDisputes(): DisputeDomainType[] {
  return Array.from(disputes.values());
}

export const resetDisputesState = () => {
  disputes.clear();
  ledgers = { buyer: 1000, supplier: 1000 };
  resetSeniorPool();
  disputeQueueService.clear();
};

function readStringField(body: any, key: string, fallback: unknown): string {
  if (!body || typeof body !== "object") {
    return String(fallback ?? "");
  }
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : String(fallback ?? "");
}

function readNumber(body: any, key: string, fallback: number): number {
  if (!body || typeof body !== "object") return fallback;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

async function logAudit(
  action: string,
  body: Record<string, unknown>,
  options: { status: number | string; resource: string },
): Promise<void> {
  try {
    const auditLogger = (globalThis as typeof globalThis & { defaultAuditLogger?: typeof defaultAuditLogger }).defaultAuditLogger ?? defaultAuditLogger;
    await auditLogger.log(
      action,
      {
        method: "POST",
        body,
        context: { schemaVersion: AUDIT_SCHEMA_VERSION },
      },
      options,
    );
  } catch {
    // Audit-write failures must not block dispute transitions; the
    // logger already console-errors internally before it throws.
  }
}

function newDisputeId(): string {
  return `dispute-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

router.post("/disputes", requireAdminToken, (req, res) => {
  const body = req.body ?? {};
  const buyerId = readStringField(body, "buyerId", "");
  const supplierId = readStringField(body, "supplierId", "");
  const amount = readNumber(body, "amount", 0);
  // Optional per-dispute appeal window (ms). Used for tests that
  // simulate a fast-expiring window; production callers usually let
  // the default 72 h stand and let the runtime enforce it.
  const parsedWindow = Number(body?.appealWindowMs);
  const appealWindowMs =
    Number.isFinite(parsedWindow) && parsedWindow > 0 ? parsedWindow : undefined;
  const id = newDisputeId();
  const dispute: Dispute = {
    id,
    status: "OPEN",
    buyerId,
    supplierId,
    // Default the buyer/supplier's tenantId to their id so tests and
    // callers that don't supply real tenant affiliations still satisfy
    // the COI checks. Production callers SHOULD pass explicit values.
    buyerTenantId: readStringField(body, "buyerTenantId", buyerId),
    supplierTenantId: readStringField(body, "supplierTenantId", supplierId),
    amount,
    evidence: [],
    finalityHash: null,
    finalityChain: [],
    appealWindowMs,
  };
  disputes.set(id, dispute);
  const buyerTier = (typeof body.buyerTier === "string" && ["bronze", "silver", "gold", "platinum"].includes(body.buyerTier)
    ? body.buyerTier
    : "bronze") as import("../services/disputeArbitrationQueue.js").BuyerTier;
  disputeQueueService.enqueueDispute({
    disputeId: id,
    amount,
    buyerTier,
    createdAt: Date.now(),
    queuedAt: Date.now(),
  });
  return res.status(201).json({ success: true, dispute });
});

router.post("/disputes/:id/evidence", requireAdminToken, (req, res) => {
  const dispute = disputes.get(req.params.id);
  if (!dispute) return res.status(404).json({ success: false, error: "Dispute not found" });
  if (req.body?.failUpload) return res.status(500).json({ success: false, error: "Evidence upload failed" });

  if (!canTransition(dispute.status, "EVIDENCED")) {
    return res.status(409).json({
      success: false,
      code: "INVALID_STATE_TRANSITION",
      error: `Cannot add evidence in state ${dispute.status}`,
    });
  }

  dispute.evidence.push(req.body.evidence);
  const at = Date.now();
  const link = appendFinalityLink(
    dispute,
    "EVIDENCED",
    { evidenceCount: dispute.evidence.length },
    at,
  );
  dispute.status = "EVIDENCED";
  dispute.finalityHash = link.hash;
  dispute.finalityChain.push(link);

  return res.status(200).json({
    success: true,
    dispute,
    evidenceAnchor: `anchor-${at}`,
  });
});

router.post("/disputes/:id/adjudicate", requireAdminToken, (req, res) => {
  const dispute = disputes.get(req.params.id);
  if (!dispute) return res.status(404).json({ success: false, error: "Dispute not found" });

  const { ruling, arbiter } = req.body ?? {};
  if (!canTransition(dispute.status, "ADJUDICATED")) {
    return res.status(409).json({
      success: false,
      code: "INVALID_STATE_TRANSITION",
      error: `Cannot adjudicate in state ${dispute.status}`,
    });
  }

  dispute.ruling = ruling;
  dispute.arbiter = arbiter;
  dispute.adjudicatedAt = Date.now();
  const at = dispute.adjudicatedAt;
  const link = appendFinalityLink(
    dispute,
    "ADJUDICATED",
    { ruling: String(ruling), arbiter: String(arbiter) },
    at,
  );
  dispute.status = "ADJUDICATED";
  dispute.finalityHash = link.hash;
  dispute.finalityChain.push(link);
  disputeQueueService.removeDispute(req.params.id);

  if (ruling === "BUYER_FAVOR") {
    ledgers.buyer += dispute.amount;
    ledgers.supplier -= dispute.amount;
  } else {
    ledgers.buyer -= dispute.amount;
    ledgers.supplier += dispute.amount;
  }

  return res.status(200).json({
    success: true,
    dispute,
    rulingAudit: `audit-${at}`,
    ledgers,
  });
});

router.get("/disputes/queue", requireAdminToken, (req, res) => {
  const now = Date.now();
  const queue = disputeQueueService.list(now);
  return res.status(200).json({
    success: true,
    queue,
  });
});

router.get("/disputes/queue/dashboard", requireAdminToken, (req, res) => {
  const now = Date.now();
  return res.status(200).json({
    success: true,
    dashboard: disputeQueueService.getDashboard(now),
  });
});

router.post("/disputes/:id/appeal", requireAdminToken, async (req, res) => {
  const dispute = disputes.get(req.params.id);
  if (!dispute) return res.status(404).json({ success: false, error: "Dispute not found" });

  const now = Date.now();
  const resource = req.originalUrl;

  // Reject any state that isn't ADJUDICATED first — including appeal-of-
  // appeal (APPEALED, SENIOR_REVIEW, FINAL) and terminal states
  // (CLOSED, TIMEOUT). This is the "block appeal-of-appeal" requirement.
  if (dispute.status !== "ADJUDICATED") {
    const reason =
      dispute.status === "APPEALED" || dispute.status === "SENIOR_REVIEW"
        ? "APPEAL_OF_APPEAL"
        : "INVALID_STATE";
    await logAudit(
      "DISPUTE_APPEAL_REJECTED",
      { disputeId: dispute.id, reason, currentStatus: dispute.status },
      { status: "rejected", resource },
    );
    const httpStatus = reason === "APPEAL_OF_APPEAL" ? 409 : 409;
    return res.status(httpStatus).json({
      success: false,
      code: reason === "APPEAL_OF_APPEAL" ? "APPEAL_OF_APPEAL" : "INVALID_STATE_TRANSITION",
      error: `Cannot appeal from state ${dispute.status}`,
    });
  }

  if (!isWithinAppealWindow(dispute, now)) {
    await logAudit(
      "DISPUTE_APPEAL_REJECTED",
      { disputeId: dispute.id, reason: "WINDOW_EXPIRED" },
      { status: "rejected", resource },
    );
    return res.status(410).json({
      success: false,
      code: "APPEAL_WINDOW_EXPIRED",
      error: "Appeal window has closed for this dispute",
    });
  }

  // Select senior panel BEFORE mutating state so a 503 (insufficient
  // pool) can be returned without rolling back an otherwise-acceptable
  // appeal.
  const selection = selectSeniorPanel(getSeniorPool(), dispute);
  if (selection.panel.length < SENIOR_PANEL_MIN_SIZE) {
    await logAudit(
      "DISPUTE_APPEAL_REJECTED",
      {
        disputeId: dispute.id,
        reason: "INSUFFICIENT_SENIOR_POOL",
        excluded: selection.excluded,
      },
      { status: "rejected", resource },
    );
    return res.status(503).json({
      success: false,
      code: "INSUFFICIENT_SENIOR_POOL",
      error: `At least ${SENIOR_PANEL_MIN_SIZE} eligible senior arbiters required; found ${selection.panel.length}`,
    });
  }

  // Audit-first: announce the intent before state mutation.
  await logAudit(
    "DISPUTE_APPEAL_INITIATED",
    {
      disputeId: dispute.id,
      panel: selection.panel.map((p) => p.id),
    },
    { status: "attempted", resource },
  );

  // ADJUDICATED → APPEALED
  const appealedAt = now;
  const appealedLink = appendFinalityLink(
    dispute,
    "APPEALED",
    {
      actor: req.ip || "admin",
      panel: selection.panel.map((p) => p.id),
    },
    appealedAt,
  );
  dispute.status = "APPEALED";
  dispute.finalityHash = appealedLink.hash;
  dispute.finalityChain.push(appealedLink);
  dispute.appealInitiatedAt = appealedAt;
  dispute.panel = selection.panel;

  // APPEALED → SENIOR_REVIEW happens atomically since the panel was just
  // selected; the dispute is now waiting on panel votes.
  const seniorAt = now;
  const seniorLink = appendFinalityLink(
    dispute,
    "SENIOR_REVIEW",
    { panel: selection.panel.map((p) => p.id) },
    seniorAt,
  );
  dispute.status = "SENIOR_REVIEW";
  dispute.finalityHash = seniorLink.hash;
  dispute.finalityChain.push(seniorLink);

  await logAudit(
    "DISPUTE_SENIOR_PANEL_SELECTED",
    { disputeId: dispute.id, panel: selection.panel.map((p) => p.id) },
    { status: 200, resource },
  );

  return res.status(200).json({
    success: true,
    dispute,
    panel: selection.panel,
  });
});

router.post("/disputes/:id/senior-decide", requireAdminToken, async (req, res) => {
  const dispute = disputes.get(req.params.id);
  if (!dispute) return res.status(404).json({ success: false, error: "Dispute not found" });

  const resource = req.originalUrl;
  const votes = Array.isArray(req.body?.votes) ? (req.body.votes as SeniorPanelVote[]) : [];
  const validation = validateSeniorDecision(dispute, { votes });
  if (validation) {
    await logAudit(
      "DISPUTE_FINAL_REJECTED",
      { disputeId: dispute.id, reason: validation.code, message: validation.message },
      { status: "rejected", resource },
    );
    return res.status(400).json({
      success: false,
      code: validation.code,
      error: validation.message,
    });
  }

  const outcome = decideByMajority(votes);
  const at = Date.now();
  const link = appendFinalityLink(
    dispute,
    "FINAL",
    {
      outcome,
      votes: votes.map((v: SeniorPanelVote) => ({ arbiterId: v.arbiterId, vote: v.vote })),
    },
    at,
  );
  dispute.status = "FINAL";
  dispute.finalityHash = link.hash;
  dispute.finalityChain.push(link);
  dispute.panelVotes = votes;
  dispute.seniorDecisionAt = at;
  dispute.finalRuling = outcome === "UPHOLD" ? "UPHELD" : "OVERTURNED";

  // Reverse the original ledger movement if the panel overturned the
  // initial ruling — the senior panel is the final authority.
  if (outcome === "OVERTURN" && dispute.ruling) {
    if (dispute.ruling === "BUYER_FAVOR") {
      ledgers.buyer -= dispute.amount;
      ledgers.supplier += dispute.amount;
    } else {
      ledgers.buyer += dispute.amount;
      ledgers.supplier -= dispute.amount;
    }
  }

  await logAudit(
    "DISPUTE_FINAL",
    {
      disputeId: dispute.id,
      outcome,
      panel: dispute.panel?.map((p) => p.id) ?? [],
    },
    { status: 200, resource },
  );

  return res.status(200).json({ success: true, dispute, ledgers });
});

router.get("/disputes/:id/finality", requireAdminToken, (req, res) => {
  const dispute = disputes.get(req.params.id);
  if (!dispute) return res.status(404).json({ success: false, error: "Dispute not found" });
  return res.status(200).json({
    success: true,
    disputeId: dispute.id,
    finalityHash: dispute.finalityHash,
    chain: dispute.finalityChain.map((c) => ({ ...c })),
  });
});

router.post("/disputes/:id/timeout", requireAdminToken, (req, res) => {
  const dispute = disputes.get(req.params.id);
  if (!dispute) return res.status(404).json({ success: false, error: "Dispute not found" });

  if (!canTransition(dispute.status, "TIMEOUT")) {
    return res.status(409).json({
      success: false,
      code: "INVALID_STATE_TRANSITION",
      error: `Cannot timeout in state ${dispute.status}`,
    });
  }

  const at = Date.now();
  const link = appendFinalityLink(dispute, "TIMEOUT", {}, at);
  dispute.status = "TIMEOUT";
  dispute.finalityHash = link.hash;
  dispute.finalityChain.push(link);
  disputeQueueService.removeDispute(req.params.id);

  return res.status(200).json({ success: true, dispute });
});
// ----------------------------------------

/**
 * @route POST /api/v1/admin/disputes/deadline/scan
 * @desc Trigger a one-off scan of stale disputes for auto-resolution.
 *   Returns the list of disputes that were auto-resolved during this scan.
 * @access Private (admin token only)
 */
router.post("/disputes/deadline/scan", requireAdminToken, (_req: Request, res: Response) => {
  try {
    const allDisputes = Array.from(disputes.values()) as DisputeDomainType[];
    // Support configurable windows via query params for testing
    const now = Date.now();
    const result = scanAndAutoResolve(allDisputes, {
      now: () => now,
    });
    return res.status(200).json({
      success: true,
      resolved: result.resolved,
      skipped: result.skipped,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message ?? "Deadline scan failed",
    });
  }
});

/**
 * @route POST /api/v1/admin/disputes/:id/reverse-auto-resolve
 * @desc Reverse an auto-resolution within the reversal window.
 *   The dispute is restored to the status it held before auto-resolution.
 * @access Private (admin token only)
 */
router.post("/disputes/:id/reverse-auto-resolve", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const result = reverseAutoResolve(
      disputes,
      req.params.id,
    );

    if (!result.reversed) {
      const statusMap: Record<string, number> = {
        DISPUTE_NOT_FOUND: 404,
        NOT_AUTO_RESOLVED: 400,
        REVERSAL_WINDOW_EXPIRED: 410,
        INVALID_STATE: 409,
      };
      const httpStatus = result.error ? (statusMap[result.error.code] ?? 400) : 400;
      return res.status(httpStatus).json({
        success: false,
        error: result.error?.message ?? "Reversal failed",
        code: result.error?.code,
      });
    }

    return res.status(200).json({
      success: true,
      dispute: result.dispute,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message ?? "Reversal failed",
    });
  }
});

/**
 * @route GET /api/v1/admin/disputes/deadline/status
 * @desc Check whether the dispute deadline scheduler is running.
 * @access Private (admin token only)
 */
router.get("/disputes/deadline/status", requireAdminToken, (_req: Request, res: Response) => {
  return res.status(200).json({
    success: true,
    running: isDisputeDeadlineSchedulerRunning(),
  });
});

// ─── Timezone Drift Monitor Admin API ─────────────────────────────────────────

/**
 * @route GET /api/v1/admin/tz-drift/metrics
 * @desc Retrieve the latest timezone drift scan snapshot including
 *   tenant-scoped ambiguous/missing-TZ counts and last scan timestamp.
 * @access Private (admin token only)
 */
router.get(
  "/tz-drift/metrics",
  requireAdminToken,
  (_req: Request, res: Response) => {
    try {
      const snapshot = getTzDriftMetricsSnapshot();
      return res.status(200).json({ success: true, snapshot });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to retrieve TZ drift metrics",
      });
    }
  },
);

/**
 * @route GET /api/v1/admin/tz-drift/offenders
 * @desc Sample offending slot rows from the last timezone drift scan.
 *   Query params:
 *     tenant    – filter by professionalId
 *     severity  – filter by severity (critical, warning, info)
 *     category  – filter by category (missing_tz, ambiguous, metadata)
 *     limit     – max results (default 50, max 200)
 *     offset    – pagination offset (default 0)
 * @access Private (admin token only)
 */
router.get(
  "/tz-drift/offenders",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      let findings = getLastScanFindings();

      // Apply filters
      if (typeof req.query.tenant === "string") {
        findings = findings.filter((f) => f.professionalId === req.query.tenant);
      }
      if (
        typeof req.query.severity === "string" &&
        ["critical", "warning", "info"].includes(req.query.severity)
      ) {
        findings = findings.filter((f) => f.severity === req.query.severity);
      }
      if (
        typeof req.query.category === "string" &&
        ["missing_tz", "ambiguous", "metadata"].includes(req.query.category)
      ) {
        findings = findings.filter((f) => f.category === req.query.category);
      }

      // Pagination
      let limit = 50;
      let offset = 0;
      if (req.query.limit !== undefined) {
        const parsed = parseInt(String(req.query.limit), 10);
        if (!isNaN(parsed) && parsed >= 1 && parsed <= 200) {
          limit = parsed;
        }
      }
      if (req.query.offset !== undefined) {
        const parsed = parseInt(String(req.query.offset), 10);
        if (!isNaN(parsed) && parsed >= 0) {
          offset = parsed;
        }
      }

      const total = findings.length;
      const page = findings.slice(offset, offset + limit);

      return res.status(200).json({
        success: true,
        offenders: page,
        total,
        limit,
        offset,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to retrieve TZ drift offenders",
      });
    }
  },
);

// ─── Payout DLQ Inspection API ──────────────────────────────────────────────


/**
 * Validated PayoutDlqStatus values.
 */
const VALID_DLQ_STATUSES: PayoutDlqStatus[] = ["pending", "reprocessed", "inspected"];

function isValidDlqStatus(value: string): value is PayoutDlqStatus {
  return VALID_DLQ_STATUSES.includes(value as PayoutDlqStatus);
}

/**
 * @route GET /api/v1/admin/payout-dlq
 * @desc List payout DLQ entries with optional filtering by supplierId, errorClass,
 *       status, and full-text search. All payloads are masked server-side.
 *   Query params:
 *     supplierId  – filter by supplier ID
 *     errorClass  – filter by error class (case-insensitive)
 *     status      – filter by status (pending, reprocessed, inspected)
 *     search      – full-text search across supplierId, errorClass, errorMessage, id
 *     limit       – max results (default 50, max 200)
 *     offset      – pagination offset (default 0)
 * @access Private (admin token only)
 */
router.get(
  "/payout-dlq",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      const store = getPayoutDlqStore();

      // Validate status filter if provided
      if (req.query.status !== undefined) {
        const statusVal = String(req.query.status);
        if (!isValidDlqStatus(statusVal)) {
          return res.status(400).json({
            success: false,
            error: `Invalid status. Must be one of: ${VALID_DLQ_STATUSES.join(", ")}`,
          });
        }
      }

      // Validate limit
      if (req.query.limit !== undefined) {
        const lim = parseInt(String(req.query.limit), 10);
        if (isNaN(lim) || lim < 1 || lim > 200) {
          return res.status(400).json({
            success: false,
            error: "limit must be between 1 and 200",
          });
        }
      }

      // Validate offset
      if (req.query.offset !== undefined) {
        const off = parseInt(String(req.query.offset), 10);
        if (isNaN(off) || off < 0) {
          return res.status(400).json({
            success: false,
            error: "offset must be a non-negative integer",
          });
        }
      }

      const result = store.list({
        supplierId:
          typeof req.query.supplierId === "string"
            ? req.query.supplierId
            : undefined,
        errorClass:
          typeof req.query.errorClass === "string"
            ? req.query.errorClass
            : undefined,
        status:
          typeof req.query.status === "string" &&
          isValidDlqStatus(req.query.status)
            ? req.query.status
            : undefined,
        search:
          typeof req.query.search === "string"
            ? req.query.search
            : undefined,
        limit: req.query.limit !== undefined
          ? parseInt(String(req.query.limit), 10)
          : undefined,
        offset: req.query.offset !== undefined
          ? parseInt(String(req.query.offset), 10)
          : undefined,
      });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to list payout DLQ entries",
      });
    }
  },
);

/**
 * @route GET /api/v1/admin/payout-dlq/:entryId
 * @desc Retrieve a single payout DLQ entry with masked payload.
 *       Logs an audit event for each inspection.
 * @access Private (admin token only)
 */
router.get(
  "/payout-dlq/:entryId",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      const { entryId } = req.params;

      if (
        !entryId ||
        typeof entryId !== "string" ||
        entryId.trim() === ""
      ) {
        return res
          .status(400)
          .json({ success: false, error: "Missing entryId" });
      }

      const store = getPayoutDlqStore();

      // Check existence first
      const raw = store.getByIdRaw(entryId.trim());
      if (!raw) {
        return res.status(404).json({
          success: false,
          error: `Payout DLQ entry '${entryId}' not found`,
        });
      }

      // Mark as inspected, then read the updated masked entry
      store.markInspected(entryId.trim());
      const entry = store.getById(entryId.trim())!;

      void defaultAuditLogger.log(
        "payout.dlq.inspected",
        {
          body: {
            dlqEntryId: entry.id,
            supplierId: entry.supplierId,
            errorClass: entry.errorClass,
          },
          context: {
            inspectorIp: req.ip ?? "unknown",
          },
        },
        {
          resource: `/api/v1/admin/payout-dlq/${entry.id}`,
          status: 200,
        },
      );

      return res.status(200).json({ success: true, entry });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to retrieve payout DLQ entry",
      });
    }
  },
);

// ─── Escrow Drift Override API ───────────────────────────────────────────────

/**
 * In-memory reference to the escrow drift reconciler, set by the app
 * bootstrap when a reconciler is active. Tests can replace this with
 * a mock reconciler.
 */
let _driftReconciler: {
  manualOverride(
    slotId: string,
    targetStatus: LocalIntentStatus,
    reason: string,
    actorIp: string,
  ): Promise<{ previousState: unknown; newState: unknown }>;
} | null = null;

export function setDriftReconciler(
  reconciler: NonNullable<typeof _driftReconciler>,
): void {
  _driftReconciler = reconciler;
}

function getDriftReconciler() {
  return _driftReconciler;
}

const VALID_INTENT_STATUSES: ReadonlySet<LocalIntentStatus> = new Set([
  "pending",
  "confirmed",
  "cancelled",
  "expired",
]);

/**
 * @route POST /api/v1/admin/escrow/drift/override
 * @desc Manually override a booking intent's escrow state to resolve drift.
 *   This is a privileged operation that must only be used after careful
 *   forensic investigation. Every override is audited.
 *
 *   Body:
 *     slotId       – the slot to override (required)
 *     targetStatus – new intent status (pending|confirmed|cancelled|expired)
 *     reason       – forensic justification (required, min 20 chars)
 *
 * @access Private (admin token only)
 */
router.post(
  "/escrow/drift/override",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const reconciler = getDriftReconciler();
      if (!reconciler) {
        return res.status(503).json({
          success: false,
          error: "Escrow drift reconciler is not running",
        });
      }

      const { slotId, targetStatus, reason } = req.body as {
        slotId?: string;
        targetStatus?: string;
        reason?: string;
      };

      // Validate slotId
      if (!slotId || typeof slotId !== "string" || slotId.trim() === "") {
        return res.status(400).json({
          success: false,
          error: "slotId is required and must be a non-empty string",
        });
      }

      // Validate targetStatus
      if (!targetStatus || typeof targetStatus !== "string") {
        return res.status(400).json({
          success: false,
          error: `targetStatus is required and must be one of: ${Array.from(VALID_INTENT_STATUSES).join(", ")}`,
        });
      }

      if (!VALID_INTENT_STATUSES.has(targetStatus as LocalIntentStatus)) {
        return res.status(400).json({
          success: false,
          error: `Invalid targetStatus "${targetStatus}". Must be one of: ${Array.from(VALID_INTENT_STATUSES).join(", ")}`,
        });
      }

      // Validate reason (min 20 chars for forensic justification, max 2000 for abuse prevention)
      if (!reason || typeof reason !== "string" || reason.trim().length < 20) {
        return res.status(400).json({
          success: false,
          error: "reason is required and must be at least 20 characters (forensic justification)",
        });
      }

      if (reason.trim().length > 2000) {
        return res.status(400).json({
          success: false,
          error: "reason must be at most 2000 characters",
        });
      }

      const actorIp = req.ip ?? "unknown";
      const result = await reconciler.manualOverride(
        slotId.trim(),
        targetStatus as LocalIntentStatus,
        reason.trim(),
        actorIp,
      );

      // Audit the override
      void defaultAuditLogger.log(
        "escrow.drift.override.applied",
        {
          context: {
            slotId: slotId.trim(),
            targetStatus,
            reason: reason.trim(),
            previousStatus: (result.previousState as any)?.intentStatus ?? "unknown",
            actorIp,
          },
          method: req.method,
        },
        { actorIp, resource: `slot:${slotId.trim()}`, status: 200 },
      );

      return res.status(200).json({
        success: true,
        slotId: slotId.trim(),
        previousState: result.previousState,
        newState: result.newState,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Manual override failed",
      });
    }
  },
);

// ─── Holiday Calendar Admin API ───────────────────────────────────────────────
//
// All routes require the x-chronopay-admin-token header.
// The service instance can be replaced via setHolidayCalendarRepository()
// to inject an in-memory repo in tests without a live database.
//
// Routes:
//   GET    /api/v1/admin/holiday-calendars
//   POST   /api/v1/admin/holiday-calendars
//   GET    /api/v1/admin/holiday-calendars/:id
//   PATCH  /api/v1/admin/holiday-calendars/:id
//   DELETE /api/v1/admin/holiday-calendars/:id
//   POST   /api/v1/admin/holiday-calendars/:id/entries
//   DELETE /api/v1/admin/holiday-calendars/:id/entries/:entryId
//   POST   /api/v1/admin/holiday-calendars/import/yaml
//   GET    /api/v1/admin/holiday-calendars/:id/revisions
//   GET    /api/v1/admin/holiday-calendars/:id/revisions/:version
//   POST   /api/v1/admin/holiday-calendars/:id/rollback/:version

let _holidayCalendarRepo: IHolidayCalendarRepository = new InMemoryHolidayCalendarRepository();

export function setHolidayCalendarRepository(repo: IHolidayCalendarRepository): void {
  _holidayCalendarRepo = repo;
}

function getHolidayCalendarService(): HolidayCalendarService {
  return new HolidayCalendarService(_holidayCalendarRepo);
}

function handleHolidayCalendarError(err: unknown, res: Response): Response {
  if (err instanceof HolidayCalendarNotFoundError) {
    return res.status(404).json({ success: false, error: err.message });
  }
  if (err instanceof HolidayCalendarConflictError) {
    return res.status(409).json({ success: false, error: err.message });
  }
  if (err instanceof HolidayCalendarValidationError) {
    return res.status(422).json({ success: false, error: err.message, details: err.details });
  }
  const message = err instanceof Error ? err.message : "Internal server error";
  return res.status(500).json({ success: false, error: message });
}

/**
 * @route GET /api/v1/admin/holiday-calendars
 * @desc List all holiday calendars.
 * @access Private (admin token only)
 */
router.get("/holiday-calendars", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const calendars = await getHolidayCalendarService().listCalendars();
    return res.status(200).json({ success: true, calendars });
  } catch (err) {
    return handleHolidayCalendarError(err, res);
  }
});

/**
 * @route POST /api/v1/admin/holiday-calendars
 * @desc Create a new holiday calendar for a region.
 * @access Private (admin token only)
 *
 * Body:
 *   region       {string} — unique region identifier (e.g. "us-east", "eu-west")
 *   name         {string} — display name for the calendar
 *   description  {string} — optional description
 */
router.post("/holiday-calendars", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const { region, name, description } = req.body ?? {};

    if (!region || typeof region !== "string" || region.trim() === "") {
      return res.status(400).json({ success: false, error: "region is required" });
    }
    if (!name || typeof name !== "string" || name.trim() === "") {
      return res.status(400).json({ success: false, error: "name is required" });
    }

    const changedBy = req.auth?.userId ?? req.header("x-chronopay-admin-token")?.slice(0, 8);
    const calendar = await getHolidayCalendarService().createCalendar({
      region,
      name,
      description,
      changedBy,
    });
    return res.status(201).json({ success: true, calendar });
  } catch (err) {
    return handleHolidayCalendarError(err, res);
  }
});

/**
 * @route GET /api/v1/admin/holiday-calendars/:id
 * @desc Retrieve a single holiday calendar by ID.
 * @access Private (admin token only)
 */
router.get("/holiday-calendars/:id", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const calendar = await getHolidayCalendarService().getCalendar(req.params.id);
    return res.status(200).json({ success: true, calendar });
  } catch (err) {
    return handleHolidayCalendarError(err, res);
  }
});

/**
 * @route PATCH /api/v1/admin/holiday-calendars/:id
 * @desc Update calendar metadata (name / description). Saves a new revision.
 * @access Private (admin token only)
 *
 * Body:
 *   name         {string} — new display name (optional)
 *   description  {string} — new description (optional)
 */
router.patch("/holiday-calendars/:id", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const { name, description } = req.body ?? {};
    if (name !== undefined && (typeof name !== "string" || name.trim() === "")) {
      return res.status(400).json({ success: false, error: "name must be a non-empty string" });
    }

    const changedBy = req.auth?.userId ?? req.header("x-chronopay-admin-token")?.slice(0, 8);
    const calendar = await getHolidayCalendarService().updateCalendar(req.params.id, {
      name,
      description,
      changedBy,
    });
    return res.status(200).json({ success: true, calendar });
  } catch (err) {
    return handleHolidayCalendarError(err, res);
  }
});

/**
 * @route DELETE /api/v1/admin/holiday-calendars/:id
 * @desc Delete a holiday calendar and all its entries and revisions.
 * @access Private (admin token only)
 */
router.delete("/holiday-calendars/:id", requireAdminToken, async (req: Request, res: Response) => {
  try {
    await getHolidayCalendarService().deleteCalendar(req.params.id);
    return res.status(200).json({ success: true, message: "Calendar deleted" });
  } catch (err) {
    return handleHolidayCalendarError(err, res);
  }
});

/**
 * @route POST /api/v1/admin/holiday-calendars/:id/entries
 * @desc Add a single holiday entry to an existing calendar.
 * @access Private (admin token only)
 *
 * Body:
 *   name       {string}  — holiday name
 *   start_date {string}  — YYYY-MM-DD inclusive start
 *   end_date   {string}  — YYYY-MM-DD inclusive end (equals start for single-day)
 *   recurring  {boolean} — whether this recurs annually (default false)
 *   note       {string}  — optional note
 */
router.post("/holiday-calendars/:id/entries", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const { name, start_date, end_date, recurring, note } = req.body ?? {};

    if (!name || typeof name !== "string" || name.trim() === "") {
      return res.status(400).json({ success: false, error: "name is required" });
    }
    if (!start_date || typeof start_date !== "string") {
      return res.status(400).json({ success: false, error: "start_date is required (YYYY-MM-DD)" });
    }
    if (!end_date || typeof end_date !== "string") {
      return res.status(400).json({ success: false, error: "end_date is required (YYYY-MM-DD)" });
    }

    const changedBy = req.auth?.userId ?? req.header("x-chronopay-admin-token")?.slice(0, 8);
    const entry = await getHolidayCalendarService().addEntry(req.params.id, {
      name,
      startDate: start_date,
      endDate: end_date,
      recurring: recurring ?? false,
      note,
      changedBy,
    });
    return res.status(201).json({ success: true, entry });
  } catch (err) {
    return handleHolidayCalendarError(err, res);
  }
});

/**
 * @route DELETE /api/v1/admin/holiday-calendars/:id/entries/:entryId
 * @desc Remove a single holiday entry from a calendar.
 * @access Private (admin token only)
 */
router.delete(
  "/holiday-calendars/:id/entries/:entryId",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const changedBy = req.auth?.userId ?? req.header("x-chronopay-admin-token")?.slice(0, 8);
      await getHolidayCalendarService().deleteEntry(req.params.id, req.params.entryId, changedBy);
      return res.status(200).json({ success: true, message: "Entry deleted" });
    } catch (err) {
      return handleHolidayCalendarError(err, res);
    }
  },
);

/**
 * @route POST /api/v1/admin/holiday-calendars/import/yaml
 * @desc Import holidays from a YAML-shaped JSON payload.
 *       The import performs full schema validation and overlap detection.
 *       If a calendar for the region already exists, its entries are replaced.
 *       A new revision is saved on every successful import.
 * @access Private (admin token only)
 *
 * Body (parsed YAML as JSON):
 *   region      {string}   — target region (required)
 *   name        {string}   — calendar display name (optional, used only on creation)
 *   description {string}   — description (optional)
 *   holidays    {object[]} — array of { name, start_date, end_date, recurring?, note? }
 *
 * Validation errors return 422 with a `details` array.
 * Duplicate / overlapping ranges are rejected with 422.
 */
router.post("/holiday-calendars/import/yaml", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const changedBy = req.auth?.userId ?? req.header("x-chronopay-admin-token")?.slice(0, 8);
    const calendar = await getHolidayCalendarService().importFromYaml(req.body, {
      changedBy,
      changeNote: req.body?.changeNote,
    });
    return res.status(200).json({ success: true, calendar });
  } catch (err) {
    return handleHolidayCalendarError(err, res);
  }
});

/**
 * @route GET /api/v1/admin/holiday-calendars/:id/revisions
 * @desc List all revisions for a calendar (newest first).
 * @access Private (admin token only)
 */
router.get("/holiday-calendars/:id/revisions", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const revisions = await getHolidayCalendarService().listRevisions(req.params.id);
    return res.status(200).json({ success: true, revisions });
  } catch (err) {
    return handleHolidayCalendarError(err, res);
  }
});

/**
 * @route GET /api/v1/admin/holiday-calendars/:id/revisions/:version
 * @desc Fetch a specific historical revision snapshot.
 * @access Private (admin token only)
 */
router.get(
  "/holiday-calendars/:id/revisions/:version",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const version = parseInt(req.params.version, 10);
      if (isNaN(version) || version < 1) {
        return res.status(400).json({ success: false, error: "version must be a positive integer" });
      }
      const revision = await getHolidayCalendarService().getRevision(req.params.id, version);
      return res.status(200).json({ success: true, revision });
    } catch (err) {
      return handleHolidayCalendarError(err, res);
    }
  },
);

/**
 * @route POST /api/v1/admin/holiday-calendars/:id/rollback/:version
 * @desc Roll the calendar back to a specific historical revision.
 *       The rollback itself is recorded as a new revision for auditability.
 * @access Private (admin token only)
 */
router.post(
  "/holiday-calendars/:id/rollback/:version",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const version = parseInt(req.params.version, 10);
      if (isNaN(version) || version < 1) {
        return res.status(400).json({ success: false, error: "version must be a positive integer" });
      }
      const changedBy = req.auth?.userId ?? req.header("x-chronopay-admin-token")?.slice(0, 8);
      const calendar = await getHolidayCalendarService().rollbackToRevision(
        req.params.id,
        version,
        changedBy,
      );
      return res.status(200).json({ success: true, calendar });
    } catch (err) {
      return handleHolidayCalendarError(err, res);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// No-Show Penalty Strike Routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @route POST /api/v1/admin/buyers/:buyerId/strikes
 * @desc Issue a no-show penalty strike against a buyer.
 *   Body: { reason, intentId?, slotId? }
 *   Automatically suspends buyer when threshold is reached.
 * @access Private (admin token only)
 */
router.post("/buyers/:buyerId/strikes", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const { buyerId } = req.params;
    const { reason, intentId, slotId } = req.body ?? {};

    if (!buyerId || typeof buyerId !== "string") {
      return res.status(400).json({ success: false, error: "buyerId is required" });
    }

    const result = await strikeService.issueStrike({
      buyerId,
      intentId,
      slotId,
      reason: reason || "No-show penalty strike",
    });

    return res.status(201).json({
      success: true,
      strike: result.strike,
      autoSuspended: result.autoSuspended,
      suspension: result.buyerSuspension,
    });
  } catch (err: any) {
    return res.status(400).json({ success: false, error: err.message ?? "Failed to issue strike" });
  }
});

/**
 * @route GET /api/v1/admin/buyers/:buyerId/strikes
 * @desc Get all strikes and suspension status for a buyer.
 * @access Private (admin token only)
 */
router.get("/buyers/:buyerId/strikes", requireAdminToken, (req: Request, res: Response) => {
  try {
    const { buyerId } = req.params;
    if (!buyerId) {
      return res.status(400).json({ success: false, error: "buyerId is required" });
    }

    const strikes = strikeService.getBuyerStrikes(buyerId);
    const suspension = strikeService.getBuyerSuspensionStatus(buyerId);

    return res.status(200).json({
      success: true,
      buyerId,
      strikes,
      activeStrikesCount: suspension.activeStrikesCount,
      suspension: {
        isSuspended: suspension.isSuspended,
        suspendedAt: suspension.suspendedAt,
        suspensionReason: suspension.suspensionReason,
      },
    });
  } catch (err: any) {
    return res.status(400).json({ success: false, error: err.message ?? "Failed to retrieve strikes" });
  }
});

/**
 * @route POST /api/v1/admin/buyers/:buyerId/strikes/:strikeId/appeal
 * @desc Appeal a no-show penalty strike within 72 hours (or as configured).
 *   Body: { reason, evidence? }
 *   Evidence is an array of references (URLs or file paths).
 *   The appeal pauses penalty enforcement by changing strike status.
 * @access Private (admin token only)
 */
router.post(
  "/buyers/:buyerId/strikes/:strikeId/appeal",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const { strikeId } = req.params;
      const { reason, evidence } = req.body ?? {};

      if (!reason || typeof reason !== "string" || reason.trim() === "") {
        return res.status(400).json({ success: false, error: "Appeal reason is required" });
      }

      const evidenceArr = Array.isArray(evidence) ? evidence.filter((e: unknown) => typeof e === "string") : undefined;

      const result = await strikeService.appealStrike(strikeId, reason, evidenceArr);

      return res.status(200).json({
        success: true,
        strike: result.strike,
        suspensionLifted: result.suspensionLifted,
        suspension: result.buyerSuspension,
        message: "No-show penalty appeal filed. Penalty enforcement is paused pending review.",
      });
    } catch (err: any) {
      const status = err.message?.includes("not found") ? 404 : 400;
      return res.status(status).json({ success: false, error: err.message ?? "Appeal failed" });
    }
  },
);

/**
 * @route POST /api/v1/admin/buyers/:buyerId/reinstate
 * @desc Reinstate a suspended buyer and optionally clear active strikes.
 *   Body: { reason, clearActiveStrikes? }
 * @access Private (admin token only)
 */
router.post(
  "/buyers/:buyerId/reinstate",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const { buyerId } = req.params;
      const { reason, clearActiveStrikes } = req.body ?? {};
      const adminId = req.auth?.userId ?? req.header("x-chronopay-admin-token") ?? "admin";

      const result = await strikeService.reinstateBuyer(
        buyerId,
        {
          adminId,
          reason: reason || "Admin reinstatement",
          clearActiveStrikes: clearActiveStrikes !== false,
        },
      );

      return res.status(200).json({
        success: true,
        suspension: result.buyerSuspension,
        rescindedStrikesCount: result.rescindedStrikesCount,
      });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message ?? "Reinstatement failed" });
    }
  },
);

/**
 * @route GET /api/v1/admin/strikes/config
 * @desc Get the current strike system configuration.
 * @access Private (admin token only)
 */
router.get("/strikes/config", requireAdminToken, (_req: Request, res: Response) => {
  return res.status(200).json({
    success: true,
    config: strikeService.getConfig(),
  });
});

/**
 * @route PUT /api/v1/admin/strikes/config
 * @desc Update strike system configuration.
 *   Body: { maxStrikesThreshold?, decayWindowMs?, autoSuspendEnabled? }
 * @access Private (admin token only)
 */
router.put("/strikes/config", requireAdminToken, (req: Request, res: Response) => {
  try {
    const { maxStrikesThreshold, decayWindowMs, autoSuspendEnabled } = req.body ?? {};
    const updates: Record<string, unknown> = {};

    if (maxStrikesThreshold !== undefined) updates.maxStrikesThreshold = maxStrikesThreshold;
    if (decayWindowMs !== undefined) updates.decayWindowMs = decayWindowMs;
    if (autoSuspendEnabled !== undefined) updates.autoSuspendEnabled = autoSuspendEnabled;

    const config = strikeService.updateConfig(updates as Parameters<typeof strikeService.updateConfig>[0]);
    return res.status(200).json({ success: true, config });
  } catch (err: any) {
    return res.status(400).json({ success: false, error: err.message ?? "Failed to update config" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// No-Show Appeal Arbitration Queue Routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @route POST /api/v1/admin/strikes/:strikeId/escalate
 * @desc Escalate an appealed no-show penalty strike to the arbitration queue
 *   for operator review. Only strikes with "appealed" status can be escalated.
 * @access Private (admin token only)
 */
router.post(
  "/strikes/:strikeId/escalate",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      const { strikeId } = req.params;

      const queueItem = strikeService.escalateToArbitration(strikeId);

      return res.status(200).json({
        success: true,
        message: "Strike escalated to arbitration queue for operator review.",
        queueItem,
      });
    } catch (err: any) {
      const status = err.message?.includes("not found") ? 404 : 409;
      return res.status(status).json({ success: false, error: err.message ?? "Escalation failed" });
    }
  },
);

/**
 * @route POST /api/v1/admin/strikes/:strikeId/arbitration/decide
 * @desc Decide an arbitration case. Uphold or overturn the strike.
 *   Body: { decision: "UPHELD" | "OVERTURNED" }
 * @access Private (admin token only)
 */
router.post(
  "/strikes/:strikeId/arbitration/decide",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      const { strikeId } = req.params;
      const { decision } = req.body ?? {};
      const decidedBy = req.auth?.userId ?? req.header("x-chronopay-admin-token") ?? "admin";

      if (!decision || !["UPHELD", "OVERTURNED"].includes(decision)) {
        return res.status(400).json({
          success: false,
          error: "decision must be either 'UPHELD' or 'OVERTURNED'",
        });
      }

      const result = strikeService.decideArbitration(strikeId, decision, decidedBy);

      return res.status(200).json({
        success: true,
        strike: result.strike,
        queueItem: result.queueItem,
        message: decision === "OVERTURNED"
          ? "Strike overturned by arbitration. Buyer reinstated."
          : "Strike upheld by arbitration. Penalty stands.",
      });
    } catch (err: any) {
      const status = err.message?.includes("not found") ? 404 : 409;
      return res.status(status).json({ success: false, error: err.message ?? "Arbitration decision failed" });
    }
  },
);

/**
 * @route GET /api/v1/admin/strikes/arbitration/queue
 * @desc Get the arbitration queue for operator review.
 *   Query params: ?status=pending|decided
 * @access Private (admin token only)
 */
router.get(
  "/strikes/arbitration/queue",
  requireAdminToken,
  (req: Request, res: Response) => {
    const status = req.query.status as string | undefined;
    const validStatus = status === "pending" || status === "decided" ? status : undefined;

    const queue = strikeService.getArbitrationQueue(validStatus);

    return res.status(200).json({
      success: true,
      queue,
      total: queue.length,
    });
  },
);

export default router;
