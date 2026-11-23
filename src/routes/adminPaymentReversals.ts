import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import {
  CancellationReversalService,
  CancellationReversalCurrencyMismatchError,
  isSupportedCurrency,
  setTenantPausedResolver as setReversalTenantPausedResolver,
} from "../modules/cancellation/cancellation-reversal-service.js";
import { PgCancellationReversalRepository } from "../modules/cancellation/pg-cancellation-reversal-repository.js";
import { PgCheckoutSessionRepository } from "../modules/checkout/pg-checkout-session-repository.js";
import { query } from "../db/pool.js";
import { RefundService } from "../services/refund.js";
import type { Currency } from "../types/checkout.js";

const VALID_CURRENCIES: readonly Currency[] = ["USD", "EUR", "GBP", "XLM"];

function isCurrency(value: string): value is Currency {
  return VALID_CURRENCIES.some((currency) => currency === value);
}

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

// Re-export for route-level test convenience.
export { setReversalTenantPausedResolver };

const router = Router();

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
        currency: body.currency as Currency,
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
      if (!isCurrency(currency)) {
        return res.status(400).json({
          success: false,
          error: `currency query parameter is required (one of ${VALID_CURRENCIES.join(", ")})`,
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
          : chain,
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
      paymentsCurrency: trace.payment.currency as Currency,
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

export default router;
