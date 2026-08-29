/**
 * Checkout Session Service Layer
 *
 * Business logic for checkout session management backed by PostgreSQL.
 * Expiry is computed from the `expires_at` column — no in-process timer.
 */

import { randomUUID, randomBytes } from "crypto";
import {
  CheckoutSession,
  CreateCheckoutSessionRequest,
  CheckoutSessionStatus,
  CheckoutError,
  CheckoutErrorCode,
} from "../types/checkout.js";
import { defaultAuditLogger } from "./auditLogger.js";
import { withSpan } from "../tracing/hooks.js";
import { PgCheckoutSessionRepository } from "../modules/checkout/pg-checkout-session-repository.js";
import { query } from "../db/pool.js";
import { logger } from "../utils/logger.js";

import {
  HorizonContractClient,
  StellarAsset,
  ExecutedPathPaymentQuote,
} from "../clients/horizon-contract-client.js";

const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// Singleton repository — can be overridden in tests via setCheckoutRepository().
let _repo: PgCheckoutSessionRepository = new PgCheckoutSessionRepository(query);

/** Replace the repository (for testing). */
export function setCheckoutRepository(repo: PgCheckoutSessionRepository): void {
  _repo = repo;
}

export class CheckoutSessionService {
  static clearAllSessions(): void {
    // Used by tests to reset state
  }

  private static emitAuditEvent(
    action: string,
    status: string | number,
    resource: string,
    metadata: Record<string, unknown>,
  ): void {
    defaultAuditLogger
      .log({ action: `checkout.${action}`, status, resource, metadata })
      .catch(console.error);
  }

  static async createSession(
    request: CreateCheckoutSessionRequest,
    authorizationToken?: string,
  ): Promise<CheckoutSession> {
    this.emitAuditEvent("initiated", "success", `customer:${request.customer.customerId}`, {
      amount: request.payment.amount,
      currency: request.payment.currency,
      paymentMethod: request.payment.paymentMethod,
    });

    if (process.env.REQUIRE_AUTH === "true" && !authorizationToken) {
      this.emitAuditEvent("validated", "failed", `customer:${request.customer.customerId}`, {
        reason: "Authorization required",
      });
      throw new CheckoutError(CheckoutErrorCode.UNAUTHORIZED, "Authorization required", 401);
    }

    this.emitAuditEvent("validated", "success", `customer:${request.customer.customerId}`, {});

    const now = Math.floor(Date.now() / 1000);
    const session: CheckoutSession = {
      id: randomUUID(),
      payment: request.payment,
      customer: request.customer,
      status: CheckoutSessionStatus.PENDING,
      createdAt: now,
      expiresAt: now + SESSION_TTL_SECONDS,
      metadata: request.metadata,
      successUrl: request.successUrl,
      cancelUrl: request.cancelUrl,
      updatedAt: now,
    };

    const created = await _repo.create(session);

    this.emitAuditEvent("reserved", "success", `session:${created.id}`, {
      customerId: request.customer.customerId,
      amount: request.payment.amount,
      currency: request.payment.currency,
      paymentMethod: request.payment.paymentMethod,
    });

    return created;
  }

  static async getSession(sessionId: string): Promise<CheckoutSession> {
    const session = await _repo.findById(sessionId);

    if (!session) {
      throw new CheckoutError(
        CheckoutErrorCode.SESSION_NOT_FOUND,
        `Session ${sessionId} not found`,
        404,
      );
    }

    const now = Math.floor(Date.now() / 1000);
    if (now > session.expiresAt && session.status === CheckoutSessionStatus.PENDING) {
      // Persist the expired status so subsequent reads are consistent.
      await _repo.updateSession(sessionId, {
        status: CheckoutSessionStatus.EXPIRED,
        updatedAt: now,
      });
      throw new CheckoutError(
        CheckoutErrorCode.SESSION_EXPIRED,
        "Checkout session has expired",
        410,
        { expiresAt: session.expiresAt, currentTime: now },
      );
    }

    if (session.status === CheckoutSessionStatus.EXPIRED) {
      throw new CheckoutError(
        CheckoutErrorCode.SESSION_EXPIRED,
        "Checkout session has expired",
        410,
        { expiresAt: session.expiresAt },
      );
    }

    return session;
  }

  static async completeSession(sessionId: string, paymentToken?: string): Promise<CheckoutSession> {
    const session = await this.getSession(sessionId);

    if (session.status !== CheckoutSessionStatus.PENDING) {
      this.emitAuditEvent("paid", "failed", `session:${sessionId}`, {
        reason: `Cannot complete session in ${session.status} state`,
        currentState: session.status,
      });
      throw new CheckoutError(
        CheckoutErrorCode.INVALID_SESSION_STATE,
        `Cannot complete session in ${session.status} state`,
        409,
        { currentState: session.status },
      );
    }

    const updated = await _repo.updateSession(sessionId, {
      status: CheckoutSessionStatus.COMPLETED,
      updatedAt: Math.floor(Date.now() / 1000),
      paymentToken,
    });

    this.emitAuditEvent("paid", "success", `session:${sessionId}`, {
      customerId: session.customer.customerId,
      amount: session.payment.amount,
      currency: session.payment.currency,
      paymentMethod: session.payment.paymentMethod,
      tokenProvided: !!paymentToken,
    });

    return updated;
  }

  static async failSession(sessionId: string, reason?: string): Promise<CheckoutSession> {
    const session = await this.getSession(sessionId);

    if (session.status !== CheckoutSessionStatus.PENDING) {
      this.emitAuditEvent("failed", "failed", `session:${sessionId}`, {
        reason: `Cannot fail session in ${session.status} state`,
        currentState: session.status,
      });
      throw new CheckoutError(
        CheckoutErrorCode.INVALID_SESSION_STATE,
        `Cannot fail session in ${session.status} state`,
        409,
        { currentState: session.status, reason },
      );
    }

    const metadata = { ...(session.metadata ?? {}), failureReason: reason ?? "Unknown" };
    const updated = await _repo.updateSession(sessionId, {
      status: CheckoutSessionStatus.FAILED,
      updatedAt: Math.floor(Date.now() / 1000),
      metadata,
    });

    this.emitAuditEvent("failed", "success", `session:${sessionId}`, {
      customerId: session.customer.customerId,
      reason: reason ?? "Unknown",
    });

    return updated;
  }

  static async cancelSession(sessionId: string): Promise<CheckoutSession> {
    const session = await this.getSession(sessionId);

    if (session.status !== CheckoutSessionStatus.PENDING) {
      this.emitAuditEvent("cancelled", "failed", `session:${sessionId}`, {
        reason: `Cannot cancel session in ${session.status} state`,
        currentState: session.status,
      });
      throw new CheckoutError(
        CheckoutErrorCode.INVALID_SESSION_STATE,
        `Cannot cancel session in ${session.status} state`,
        409,
        { currentState: session.status },
      );
    }

    const updated = await _repo.updateSession(sessionId, {
      status: CheckoutSessionStatus.CANCELLED,
      updatedAt: Math.floor(Date.now() / 1000),
    });

    this.emitAuditEvent("cancelled", "success", `session:${sessionId}`, {
      customerId: session.customer.customerId,
    });

    return updated;
  }

  static async paySession(sessionId: string): Promise<CheckoutSession> {
    const session = await this.getSession(sessionId);

    if (session.status !== CheckoutSessionStatus.PENDING) {
      this.emitAuditEvent("paid", "failed", `session:${sessionId}`, {
        reason: `Cannot pay for session in ${session.status} state`,
        currentState: session.status,
      });
      throw new CheckoutError(
        CheckoutErrorCode.INVALID_SESSION_STATE,
        `Cannot pay for session in ${session.status} state`,
        409,
        { currentState: session.status },
      );
    }

    const paymentSuccessful = randomBytes(1)[0] / 255 > 0.1;
    if (paymentSuccessful) {
      return this.completeSession(sessionId, "mock_token_123");
    } else {
      return this.failSession(sessionId, "Payment provider declined transaction");
    }
  }

  // ── Per-tenant slippage configuration ──────────────────────────────────────────

  private static tenantSlippageConfig: Map<string, number> = new Map();
  private static defaultSlippageTolerancePercent: number = 0.5;

  static setTenantSlippageTolerance(tenantId: string, tolerancePercent: number): void {
    if (typeof tolerancePercent !== "number" || tolerancePercent < 0 || tolerancePercent > 50) {
      throw new CheckoutError(
        "INVALID_SLIPPAGE_TOLERANCE",
        "Slippage tolerance percent must be a number between 0 and 50",
        400,
      );
    }
    this.tenantSlippageConfig.set(tenantId, tolerancePercent);
  }

  static getTenantSlippageTolerance(tenantId?: string): number {
    if (tenantId && this.tenantSlippageConfig.has(tenantId)) {
      return this.tenantSlippageConfig.get(tenantId)!;
    }
    return this.defaultSlippageTolerancePercent;
  }

  static clearTenantSlippageConfig(): void {
    this.tenantSlippageConfig.clear();
  }

  static async processPartialRefundPathPayment(
    request: {
      sessionId: string;
      tenantId?: string;
      refundAmount: number;
      sourceAsset?: StellarAsset;
      destinationAsset: StellarAsset;
      slippageTolerancePercent?: number;
      oracleRate?: number;
      oracleTimestamp?: number;
      oracleMaxAgeSeconds?: number;
      dustThresholdStroops?: number;
    },
    horizonClient?: HorizonContractClient,
  ): Promise<{ session: CheckoutSession; quote: ExecutedPathPaymentQuote }> {
    const session = await this.getSession(request.sessionId);

    if (session.status !== CheckoutSessionStatus.COMPLETED) {
      this.emitAuditEvent("partial_refund_path_payment", "failed", `session:${request.sessionId}`, {
        reason: `Cannot refund session in ${session.status} state`,
        currentState: session.status,
      });
      throw new CheckoutError(
        CheckoutErrorCode.INVALID_SESSION_STATE,
        `Cannot refund session in ${session.status} state`,
        409,
        { currentState: session.status },
      );
    }

    const tenantId = request.tenantId ?? (session.metadata?.tenantId as string) ?? "default";
    const tenantTolerance = this.getTenantSlippageTolerance(tenantId);
    const maxSlippageTolerancePercent =
      request.slippageTolerancePercent !== undefined
        ? Math.min(request.slippageTolerancePercent, tenantTolerance)
        : tenantTolerance;

    const sourceAsset: StellarAsset = request.sourceAsset ?? { asset_type: "native" };

    if (!horizonClient) {
      throw new CheckoutError(
        CheckoutErrorCode.INTERNAL_ERROR,
        "Horizon contract client is required for path payment refund",
        500,
      );
    }

    try {
      const quote = await horizonClient.findPathPaymentQuote({
        sourceAsset,
        sourceAmount: request.refundAmount,
        destinationAsset: request.destinationAsset,
        tenantId,
        maxSlippageTolerancePercent,
        oracleRate: request.oracleRate,
        oracleTimestamp: request.oracleTimestamp,
        oracleMaxAgeSeconds: request.oracleMaxAgeSeconds,
        dustThresholdStroops: request.dustThresholdStroops,
      });

      // Audit log the executed path payment quote for audit persistence
      this.emitAuditEvent("partial_refund_path_payment.executed", "success", `session:${request.sessionId}`, {
        sessionId: request.sessionId,
        tenantId,
        quoteId: quote.quoteId,
        sourceAmount: quote.sourceAmount,
        destinationAmount: quote.destinationAmount,
        minDestinationAmount: quote.minDestinationAmount,
        effectiveSlippagePercent: quote.effectiveSlippagePercent,
        maxSlippageTolerancePercent: quote.maxSlippageTolerancePercent,
        path: quote.path,
        quotedAt: quote.quotedAt,
      });

      // Update session metadata with audit quote
      const updatedMetadata: Record<string, string | number | boolean> = {
        ...(session.metadata ?? {}),
        lastPartialRefundQuoteId: quote.quoteId,
        lastPartialRefundDestinationAmount: quote.destinationAmount,
      };

      const updatedSession = await _repo.updateSession(request.sessionId, {
        status: session.status,
        updatedAt: Math.floor(Date.now() / 1000),
        metadata: updatedMetadata,
      });

      return { session: updatedSession, quote };
    } catch (err: any) {
      this.emitAuditEvent("partial_refund_path_payment", "failed", `session:${request.sessionId}`, {
        reason: err.message ?? "Path payment quote execution failed",
      });
      if (err instanceof CheckoutError) {
        throw err;
      }
      throw new CheckoutError("PATH_PAYMENT_FAILED", err.message ?? "Path payment failed", 400, {
        originalError: err.name,
      });
    }
  }

  // ── Traced wrappers ──────────────────────────────────────────────────────────

  static createSessionTraced(
    request: CreateCheckoutSessionRequest,
    authorizationToken?: string,
  ): Promise<CheckoutSession> {
    return withSpan(
      "checkout.createSession",
      { route: "POST /api/v1/checkout/sessions", paymentMethod: request.payment.paymentMethod },
      () => this.createSession(request, authorizationToken),
    );
  }

  static getSessionTraced(sessionId: string): Promise<CheckoutSession> {
    return withSpan(
      "checkout.getSession",
      { route: "GET /api/v1/checkout/sessions/:sessionId" },
      () => this.getSession(sessionId),
    );
  }

  static completeSessionTraced(sessionId: string, paymentToken?: string): Promise<CheckoutSession> {
    return withSpan(
      "checkout.completeSession",
      { route: "POST /api/v1/checkout/sessions/:sessionId/complete" },
      () => this.completeSession(sessionId, paymentToken),
    );
  }

  static cancelSessionTraced(sessionId: string): Promise<CheckoutSession> {
    return withSpan(
      "checkout.cancelSession",
      { route: "POST /api/v1/checkout/sessions/:sessionId/cancel" },
      () => this.cancelSession(sessionId),
    );
  }

  static paySessionTraced(sessionId: string): Promise<CheckoutSession> {
    return withSpan(
      "checkout.paySession",
      { route: "POST /api/v1/checkout/sessions/:sessionId/pay" },
      () => this.paySession(sessionId),
    );
  }

  static processPartialRefundPathPaymentTraced(
    request: Parameters<typeof CheckoutSessionService.processPartialRefundPathPayment>[0],
    horizonClient?: HorizonContractClient,
  ): Promise<{ session: CheckoutSession; quote: ExecutedPathPaymentQuote }> {
    return withSpan(
      "checkout.processPartialRefundPathPayment",
      { sessionId: request.sessionId, tenantId: request.tenantId ?? "default" },
      () => this.processPartialRefundPathPayment(request, horizonClient),
    );
  }
}
