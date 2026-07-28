import { query } from "../db/pool.js";
import {
  RefundEntry,
  CreateRefundRequest,
  PaymentTrace,
} from "../types/refund.js";
import {
  PgRefundRepository,
  defaultRefundRepository,
} from "../modules/checkout/pg-refund-repository.js";
import {
  CheckoutError,
  CheckoutErrorCode,
  CheckoutSessionStatus,
} from "../types/checkout.js";
import { defaultAuditLogger } from "./auditLogger.js";
import { PgCheckoutSessionRepository } from "../modules/checkout/pg-checkout-session-repository.js";

let _refundRepo: PgRefundRepository = defaultRefundRepository;
let _sessionRepo: PgCheckoutSessionRepository = new PgCheckoutSessionRepository(query);

export function setRefundRepository(repo: PgRefundRepository): void {
  _refundRepo = repo;
}

export function setSessionRepositoryForRefund(repo: PgCheckoutSessionRepository): void {
  _sessionRepo = repo;
}

export class RefundService {
  static async createRefund(request: CreateRefundRequest): Promise<RefundEntry> {
    const session = await _sessionRepo.findById(request.paymentId);
    if (!session) {
      throw new CheckoutError(
        CheckoutErrorCode.SESSION_NOT_FOUND,
        `Payment session ${request.paymentId} not found`,
        404,
      );
    }

    if (session.status !== CheckoutSessionStatus.COMPLETED) {
      throw new CheckoutError(
        CheckoutErrorCode.INVALID_SESSION_STATE,
        `Cannot refund session in ${session.status} state. Only completed sessions can be refunded.`,
        409,
        { currentState: session.status },
      );
    }

    const capturedAmount = session.payment.amount;
    const currentRefunded = await _refundRepo.sumRefundedCents(request.paymentId);
    const remaining = capturedAmount - currentRefunded;

    if (request.amountCents > remaining) {
      throw new CheckoutError(
        "REFUND_EXCEEDS_REMAINING",
        `Refund amount ${request.amountCents} exceeds remaining refundable amount ${remaining}. ` +
          `Captured: ${capturedAmount}, Already refunded: ${currentRefunded}`,
        422,
        { capturedAmount, alreadyRefunded: currentRefunded, remaining, requested: request.amountCents },
      );
    }

    const refund = await _refundRepo.create(request);

    defaultAuditLogger
      .log({
        action: "refund.created",
        status: "success",
        resource: `refund:${refund.id}`,
        metadata: {
          paymentId: request.paymentId,
          amountCents: request.amountCents,
          totalRefundedCents: currentRefunded + request.amountCents,
          capturedAmount,
        },
      })
      .catch(console.error);

    return refund;
  }

  static async getPaymentTrace(paymentId: string): Promise<PaymentTrace> {
    const session = await _sessionRepo.findById(paymentId);
    if (!session) {
      throw new CheckoutError(
        CheckoutErrorCode.SESSION_NOT_FOUND,
        `Payment session ${paymentId} not found`,
        404,
      );
    }

    const refunds = await _refundRepo.findByPaymentId(paymentId);
    const totalRefundedCents = refunds.reduce((sum, r) => sum + r.amountCents, 0);

    return {
      payment: {
        id: session.id,
        amountCents: session.payment.amount,
        currency: session.payment.currency,
        status: session.status,
        createdAt: session.createdAt,
      },
      refunds,
      totalRefundedCents,
      remainingCents: session.payment.amount - totalRefundedCents,
    };
  }

  static async createRefundTraced(request: CreateRefundRequest): Promise<RefundEntry> {
    const { withSpan } = await import("../tracing/hooks.js");
    return withSpan(
      "refund.create",
      { paymentId: request.paymentId, amountCents: request.amountCents },
      () => this.createRefund(request),
    );
  }

  static async getPaymentTraceTraced(paymentId: string): Promise<PaymentTrace> {
    const { withSpan } = await import("../tracing/hooks.js");
    return withSpan(
      "refund.trace",
      { paymentId },
      () => this.getPaymentTrace(paymentId),
    );
  }
}