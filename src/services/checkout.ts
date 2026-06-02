/**
 * Checkout Session Service Layer
 * 
 * Core business logic for checkout session management:
 * - Session creation with unique IDs
 * - Session retrieval and status tracking
 * - Session expiration handling (24 hours default)
 * - In-memory storage (can be extended to database)
 * - Session state validation
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

/**
 * Session storage configuration
 */
const SESSION_EXPIRATION_TIME = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const MAX_SESSIONS_STORED = 10000; // Prevent unbounded memory growth

/**
 * In-memory session storage
 * In production, this would be replaced with a database
 */
const sessionStore = new Map<string, CheckoutSession>();

/**
 * CheckoutSessionService provides core checkout functionality
 */
export class CheckoutSessionService {
  /**
   * Helper to emit audit events safely while sanitizing data
   */
  private static emitAuditEvent(
    action: string,
    status: string | number,
    resource: string,
    metadata: Record<string, any>
  ): void {
    defaultAuditLogger.log({
      action: `checkout.${action}`,
      status,
      resource,
      metadata,
    }).catch(console.error);
  }

  /**
   * Creates a new checkout session
   * 
   * @param request - Checkout session creation request
   * @param authorizationToken - Optional bearer token for authorization
   * @returns Created checkout session
   * @throws CheckoutError if validation fails
   */
  static createSession(
    request: CreateCheckoutSessionRequest,
    authorizationToken?: string,
  ): CheckoutSession {
    this.emitAuditEvent("initiated", "success", `customer:${request.customer.customerId}`, {
      amount: request.payment.amount,
      currency: request.payment.currency,
      paymentMethod: request.payment.paymentMethod,
    });

    // Validate authorization if token is required
    // In production, verify token against auth service
    if (process.env.REQUIRE_AUTH === "true" && !authorizationToken) {
      this.emitAuditEvent("validated", "failed", `customer:${request.customer.customerId}`, {
        reason: "Authorization required",
      });
      throw new CheckoutError(
        CheckoutErrorCode.UNAUTHORIZED,
        "Authorization required",
        401,
      );
    }

    // Clean expired sessions before creating new one
    this.cleanExpiredSessions();

    // Check storage limit
    if (sessionStore.size >= MAX_SESSIONS_STORED) {
      this.emitAuditEvent("validated", "failed", `customer:${request.customer.customerId}`, {
        reason: "Session limit reached",
      });
      throw new CheckoutError(
        CheckoutErrorCode.INTERNAL_ERROR,
        "Session limit reached",
        503,
      );
    }

    this.emitAuditEvent("validated", "success", `customer:${request.customer.customerId}`, {});

    const now = Date.now();
    const sessionId = randomUUID();
    const expiresAt = now + SESSION_EXPIRATION_TIME;

    const session: CheckoutSession = {
      id: sessionId,
      payment: request.payment,
      customer: request.customer,
      status: CheckoutSessionStatus.PENDING,
      createdAt: Math.floor(now / 1000), // Unix timestamp in seconds
      expiresAt: Math.floor(expiresAt / 1000),
      metadata: request.metadata,
      successUrl: request.successUrl,
      cancelUrl: request.cancelUrl,
      updatedAt: Math.floor(now / 1000),
    };

    sessionStore.set(sessionId, session);

    this.emitAuditEvent("reserved", "success", `session:${sessionId}`, {
      customerId: request.customer.customerId,
      amount: request.payment.amount,
      currency: request.payment.currency,
      paymentMethod: request.payment.paymentMethod,
    });

    return session;
  }

  /**
   * Retrieves a checkout session by ID
   * 
   * @param sessionId - Unique session identifier
   * @returns Checkout session
   * @throws CheckoutError if session not found or expired
   */
  static getSession(sessionId: string): CheckoutSession {
    const session = sessionStore.get(sessionId);

    if (!session) {
      throw new CheckoutError(
        CheckoutErrorCode.SESSION_NOT_FOUND,
        `Session ${sessionId} not found`,
        404,
      );
    }

    // Check if session has expired
    const now = Math.floor(Date.now() / 1000);
    if (now > session.expiresAt) {
      // Mark as expired and don't fetch
      session.status = CheckoutSessionStatus.EXPIRED;
      throw new CheckoutError(
        CheckoutErrorCode.SESSION_EXPIRED,
        "Checkout session has expired",
        410,
        { expiresAt: session.expiresAt, currentTime: now },
      );
    }

    return session;
  }

  /**
   * Marks a session as completed (payment successful)
   * 
   * @param sessionId - Unique session identifier
   * @param paymentToken - Optional payment confirmation token
   * @returns Updated session
   * @throws CheckoutError if session not found or in invalid state
   */
  static completeSession(sessionId: string, paymentToken?: string): CheckoutSession {
    const session = this.getSession(sessionId);

    // Only allow completion from pending state
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

    session.status = CheckoutSessionStatus.COMPLETED;
    session.paymentToken = paymentToken;
    session.updatedAt = Math.floor(Date.now() / 1000);

    sessionStore.set(sessionId, session);

    this.emitAuditEvent("paid", "success", `session:${sessionId}`, {
      customerId: session.customer.customerId,
      amount: session.payment.amount,
      currency: session.payment.currency,
      paymentMethod: session.payment.paymentMethod,
      tokenProvided: !!paymentToken,
    });

    return session;
  }

  /**
   * Marks a session as failed (payment failed)
   * 
   * @param sessionId - Unique session identifier
   * @param reason - Optional failure reason
   * @returns Updated session
   * @throws CheckoutError if session not found or in invalid state
   */
  static failSession(sessionId: string, reason?: string): CheckoutSession {
    const session = this.getSession(sessionId);

    // Only allow failure from pending state
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

    session.status = CheckoutSessionStatus.FAILED;
    session.updatedAt = Math.floor(Date.now() / 1000);
    if (!session.metadata) session.metadata = {};
    session.metadata.failureReason = reason || "Unknown";

    sessionStore.set(sessionId, session);

    this.emitAuditEvent("failed", "success", `session:${sessionId}`, {
      customerId: session.customer.customerId,
      reason: reason || "Unknown",
    });

    return session;
  }

  /**
   * Cancels a session
   * 
   * @param sessionId - Unique session identifier
   * @returns Updated session
   * @throws CheckoutError if session not found or in invalid state
   */
  static cancelSession(sessionId: string): CheckoutSession {
    const session = this.getSession(sessionId);

    // Only allow cancellation from pending state
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

    session.status = CheckoutSessionStatus.CANCELLED;
    session.updatedAt = Math.floor(Date.now() / 1000);

    sessionStore.set(sessionId, session);

    this.emitAuditEvent("cancelled", "success", `session:${sessionId}`, {
      customerId: session.customer.customerId,
    });

    return session;
  }

  /**
   * Processes payment for a session
   * 
   * @param sessionId - Unique session identifier
   * @returns Updated session
   * @throws CheckoutError if session not found or in invalid state
   */
  static paySession(sessionId: string): CheckoutSession {
    const session = this.getSession(sessionId);

    // Only allow payment from pending state
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

    // Simulate payment processing logic
    // 90% success rate
    const paymentSuccessful = Math.random() > 0.1;

    if (paymentSuccessful) {
      return this.completeSession(sessionId, "mock_token_123");
    } else {
      return this.failSession(sessionId, "Payment provider declined transaction");
    }
  }

  /**
   * Gets all sessions (for admin/testing purposes)
   * In production, this should be protected and paginated
   * 
   * @returns Array of all sessions
   */
  static getAllSessions(): CheckoutSession[] {
    this.cleanExpiredSessions();
    return Array.from(sessionStore.values());
  }

  /**
   * Returns a paginated batch of sessions ordered by insertion order.
   */
  static listSessionBatch(batchSize: number, afterId?: string): {
    sessions: CheckoutSession[];
    nextCursor?: string;
  } {
    const keys = Array.from(sessionStore.keys());
    const startIndex = afterId ? keys.indexOf(afterId) + 1 : 0;
    const pageKeys = keys.slice(startIndex, startIndex + batchSize);
    const sessions = pageKeys
      .map((id) => sessionStore.get(id))
      .filter((session): session is CheckoutSession => session !== undefined);
    const nextCursor = pageKeys.length === batchSize ? pageKeys[pageKeys.length - 1] : undefined;
    return { sessions, nextCursor };
  }

  static getSessionById(sessionId: string): CheckoutSession | undefined {
    const session = sessionStore.get(sessionId);
    return session ? { ...session } : undefined;
  }

  static persistSession(session: CheckoutSession): void {
    sessionStore.set(session.id, session);
  }

  static deleteSession(sessionId: string): boolean {
    return sessionStore.delete(sessionId);
  }

  /**
   * Cleans up expired sessions from memory
   * Prevents unbounded memory growth
   */
  static cleanExpiredSessions(): void {
    const now = Math.floor(Date.now() / 1000);
    const idsToDelete: string[] = [];

    for (const [id, session] of sessionStore.entries()) {
      if (now > session.expiresAt) {
        idsToDelete.push(id);
      }
    }

    idsToDelete.forEach((id) => sessionStore.delete(id));
  }

  /**
   * Clears all sessions (for testing)
   */
  static clearAllSessions(): void {
    sessionStore.clear();
  }

  /**
   * Gets the number of active sessions
   * @returns Number of sessions in store
   */
  static getSessionCount(): number {
    return sessionStore.size;
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
