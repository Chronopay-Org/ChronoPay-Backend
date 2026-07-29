/**
 * Partial Refund Approval Service – Issue #478
 *
 * Large partial refunds require admin sign-off above a per-currency threshold
 * before they are executed.  The flow is:
 *
 *   1. Admin A calls `initiateApproval()` → request enters PENDING state.
 *   2. A *different* Admin B calls `approveRequest()` → request moves to APPROVED
 *      and the caller receives the approved refund record to execute.
 *   3. Admin A (or another admin) can `denyRequest()` to cancel.
 *   4. Requests expire after a configurable TTL (default 30 minutes).
 *
 * Security invariants:
 *  - The initiator cannot approve their own request.
 *  - Threshold is per-currency (defaults provided; overridable at construction).
 *  - All state changes are emitted to an audit logger.
 *  - No raw amounts or actor identities are logged at DEBUG level – they only
 *    appear in the structured audit trail.
 */

import { defaultAuditLogger, AuditLogger } from "./auditLogger.js";
import { CreateRefundRequest } from "../types/refund.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default approval TTL: 30 minutes */
export const DEFAULT_APPROVAL_TTL_MS = 30 * 60 * 1000;

/**
 * Default per-currency thresholds (in minor units: cents for fiat, stroops for XLM).
 * Requests at or above these amounts require admin sign-off.
 */
export const DEFAULT_THRESHOLDS: Record<string, number> = {
  USD: 10_000_00, // $10,000.00
  EUR: 10_000_00, // €10,000.00
  GBP: 8_000_00,  // £8,000.00
  XLM: 100_000_000_000, // 10,000 XLM in stroops
};

// ─── Types ────────────────────────────────────────────────────────────────────

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface PendingApprovalRequest {
  id: string;
  refundRequest: CreateRefundRequest;
  initiatorId: string;
  status: ApprovalStatus;
  createdAt: number; // unix ms
  expiresAt: number; // unix ms
  approverId?: string;
  deniedById?: string;
  deniedReason?: string;
  resolvedAt?: number;
}

export interface InitiateApprovalResult {
  /** Whether the refund was auto-approved (below threshold) or requires sign-off. */
  requiresApproval: boolean;
  /** Present when requiresApproval is false – the caller can execute immediately. */
  autoApproved?: CreateRefundRequest;
  /** Present when requiresApproval is true – the pending approval request. */
  pendingRequest?: PendingApprovalRequest;
}

export interface ApproveResult {
  approvedRequest: PendingApprovalRequest;
  refundRequest: CreateRefundRequest;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class RefundApprovalError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "RefundApprovalError";
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

export interface PartialRefundApprovalServiceOptions {
  /**
   * Per-currency thresholds in minor units.  Merged over DEFAULT_THRESHOLDS
   * so only the currencies you want to override need to be provided.
   */
  thresholds?: Record<string, number>;
  /** Approval TTL in milliseconds.  Default: 30 minutes. */
  approvalTtlMs?: number;
  auditLogger?: AuditLogger;
  /** Injected clock (for testing).  Defaults to Date.now. */
  now?: () => number;
}

/**
 * PartialRefundApprovalService manages the two-admin approval workflow for
 * large partial refunds.
 *
 * The service is intentionally stateful (in-memory store) so it can be used
 * as a singleton or swapped for a Redis/DB-backed implementation in production.
 */
export class PartialRefundApprovalService {
  private readonly thresholds: Record<string, number>;
  private readonly approvalTtlMs: number;
  private readonly auditLogger: AuditLogger;
  private readonly now: () => number;

  // In-memory store keyed by approval request ID
  private readonly store = new Map<string, PendingApprovalRequest>();

  constructor(options: PartialRefundApprovalServiceOptions = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
    this.approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.auditLogger = options.auditLogger ?? defaultAuditLogger;
    this.now = options.now ?? (() => Date.now());
  }

  // ── Threshold check ────────────────────────────────────────────────────────

  /**
   * Returns the threshold (in minor units) for the given currency.
   * Returns Infinity if no threshold is configured (never requires approval).
   */
  thresholdFor(currency: string): number {
    return this.thresholds[currency.toUpperCase()] ?? Infinity;
  }

  /**
   * Returns true when the refund amount meets or exceeds the threshold for
   * the refund's currency.
   */
  requiresApproval(request: CreateRefundRequest): boolean {
    const threshold = this.thresholdFor(request.currency ?? "USD");
    return request.amountCents >= threshold;
  }

  // ── Workflow ───────────────────────────────────────────────────────────────

  /**
   * Initiate a refund request.  If the amount is below the threshold the
   * result is returned immediately without queuing (auto-approve).  Otherwise
   * a `PendingApprovalRequest` is stored and returned.
   */
  async initiate(
    refundRequest: CreateRefundRequest,
    initiatorId: string,
  ): Promise<InitiateApprovalResult> {
    if (!initiatorId || typeof initiatorId !== "string" || !initiatorId.trim()) {
      throw new RefundApprovalError("initiatorId is required", "INVALID_INPUT");
    }

    if (!this.requiresApproval(refundRequest)) {
      await this.auditLogger.log("refund_approval.auto_approved", {
        context: {
          paymentId: refundRequest.paymentId,
          currency: refundRequest.currency,
          initiatorId,
        },
      });
      return { requiresApproval: false, autoApproved: refundRequest };
    }

    const id = this.generateId();
    const now = this.now();
    const pending: PendingApprovalRequest = {
      id,
      refundRequest,
      initiatorId,
      status: "pending",
      createdAt: now,
      expiresAt: now + this.approvalTtlMs,
    };

    this.store.set(id, pending);

    await this.auditLogger.log("refund_approval.initiated", {
      context: {
        approvalId: id,
        paymentId: refundRequest.paymentId,
        currency: refundRequest.currency,
        initiatorId,
        expiresAt: pending.expiresAt,
      },
    });

    return { requiresApproval: true, pendingRequest: pending };
  }

  /**
   * Approve a pending request.
   *
   * @throws RefundApprovalError SELF_APPROVAL  – approver is the same admin who initiated.
   * @throws RefundApprovalError NOT_FOUND      – no pending request with this ID.
   * @throws RefundApprovalError ALREADY_RESOLVED – request is not in PENDING state.
   * @throws RefundApprovalError EXPIRED        – approval window has closed.
   */
  async approve(approvalId: string, approverId: string): Promise<ApproveResult> {
    const request = this.requirePending(approvalId);

    if (approverId === request.initiatorId) {
      throw new RefundApprovalError(
        "The approver cannot be the same admin who initiated the request",
        "SELF_APPROVAL",
      );
    }

    const resolved: PendingApprovalRequest = {
      ...request,
      status: "approved",
      approverId,
      resolvedAt: this.now(),
    };
    this.store.set(approvalId, resolved);

    await this.auditLogger.log("refund_approval.approved", {
      context: {
        approvalId,
        paymentId: request.refundRequest.paymentId,
        initiatorId: request.initiatorId,
        approverId,
      },
    });

    return { approvedRequest: resolved, refundRequest: request.refundRequest };
  }

  /**
   * Deny a pending request.
   *
   * @throws RefundApprovalError NOT_FOUND       – no pending request with this ID.
   * @throws RefundApprovalError ALREADY_RESOLVED – request is not in PENDING state.
   * @throws RefundApprovalError EXPIRED         – approval window has closed.
   */
  async deny(approvalId: string, deniedById: string, reason?: string): Promise<PendingApprovalRequest> {
    const request = this.requirePending(approvalId);

    const resolved: PendingApprovalRequest = {
      ...request,
      status: "denied",
      deniedById,
      deniedReason: reason,
      resolvedAt: this.now(),
    };
    this.store.set(approvalId, resolved);

    await this.auditLogger.log("refund_approval.denied", {
      context: {
        approvalId,
        paymentId: request.refundRequest.paymentId,
        initiatorId: request.initiatorId,
        deniedById,
        reason,
      },
    });

    return resolved;
  }

  /**
   * Retrieve a request by ID (without modifying it).
   * Marks it as expired in the store if the TTL has passed.
   */
  getById(approvalId: string): PendingApprovalRequest | undefined {
    const request = this.store.get(approvalId);
    if (!request) return undefined;
    if (request.status === "pending" && this.now() >= request.expiresAt) {
      const expired: PendingApprovalRequest = {
        ...request,
        status: "expired",
        resolvedAt: request.expiresAt,
      };
      this.store.set(approvalId, expired);
      return expired;
    }
    return request;
  }

  /**
   * List all requests, optionally filtered by status.
   * Expired pending requests are lazily resolved before being returned.
   */
  list(filter?: { status?: ApprovalStatus }): PendingApprovalRequest[] {
    const results: PendingApprovalRequest[] = [];
    for (const id of this.store.keys()) {
      const r = this.getById(id); // triggers expiry check
      if (r) {
        if (!filter?.status || r.status === filter.status) {
          results.push(r);
        }
      }
    }
    return results;
  }

  /** Reset all state (for testing). */
  _reset(): void {
    this.store.clear();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private requirePending(approvalId: string): PendingApprovalRequest {
    const request = this.getById(approvalId);
    if (!request) {
      throw new RefundApprovalError(
        `Approval request ${approvalId} not found`,
        "NOT_FOUND",
      );
    }
    if (request.status === "expired") {
      throw new RefundApprovalError(
        `Approval request ${approvalId} has expired`,
        "EXPIRED",
      );
    }
    if (request.status !== "pending") {
      throw new RefundApprovalError(
        `Approval request ${approvalId} is already ${request.status}`,
        "ALREADY_RESOLVED",
      );
    }
    return request;
  }

  private generateId(): string {
    const ts = this.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 10);
    return `rap_${ts}_${rand}`;
  }
}
