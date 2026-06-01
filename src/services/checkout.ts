/**
 * Checkout Session Service Layer
 *
 * Business logic for checkout session management backed by PostgreSQL.
 * Expiry is computed from the `expires_at` column — no in-process timer.
 */

import { randomUUID } from "crypto";
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

const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// Singleton repository — can be overridden in tests via setCheckoutRepository().
let _repo: PgCheckoutSessionRepository = new PgCheckoutSessionRepository(query);

/** Replace the repository (for testing). */
export function setCheckoutRepository(repo: PgCheckoutSessionRepository): void {
  _repo = repo;
}

export class CheckoutSessionService {
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

    const paymentSuccessful = Math.random() > 0.1;
    if (paymentSuccessful) {
      return this.completeSession(sessionId, "mock_token_123");
    } else {
      return this.failSession(sessionId, "Payment provider declined transaction");
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
}
