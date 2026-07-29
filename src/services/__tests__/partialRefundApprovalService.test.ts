/**
 * Tests for #478 – partial-refund approval workflow with threshold check and audit.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  PartialRefundApprovalService,
  RefundApprovalError,
  DEFAULT_THRESHOLDS,
} from "../partialRefundApprovalService.js";
import { CreateRefundRequest } from "../../types/refund.js";
import { AuditLogger } from "../auditLogger.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<CreateRefundRequest> = {}): CreateRefundRequest {
  return {
    paymentId: "pay-001",
    amountCents: 500_00, // $500 – below $10,000 threshold
    currency: "USD",
    reason: "customer complaint",
    refundedBy: "admin-a",
    ...overrides,
  };
}

function makeLargeRequest(overrides: Partial<CreateRefundRequest> = {}): CreateRefundRequest {
  return makeRequest({ amountCents: 15_000_00, ...overrides }); // $15,000 – above threshold
}

function makeAuditLogger(): { logger: AuditLogger; events: Array<{ action: string; ctx: unknown }> } {
  const events: Array<{ action: string; ctx: unknown }> = [];
  const logger: AuditLogger = {
    log: async (action: any, ctx?: any, _opts?: any) => {
      const eventAction = typeof action === "string" ? action : action?.action ?? "";
      events.push({ action: eventAction, ctx });
    },
  };
  return { logger, events };
}

let tick = 0;
function makeClock(startMs = 1_000_000) {
  return () => startMs + tick * 1000;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PartialRefundApprovalService – #478", () => {
  let service: PartialRefundApprovalService;
  let auditEvents: Array<{ action: string; ctx: unknown }>;
  let nowMs: number;

  beforeEach(() => {
    tick = 0;
    nowMs = 1_000_000;
    const { logger, events } = makeAuditLogger();
    auditEvents = events;
    service = new PartialRefundApprovalService({
      auditLogger: logger,
      now: () => nowMs,
    });
  });

  // ── Threshold checks ──────────────────────────────────────────────────────

  describe("requiresApproval()", () => {
    it("returns false when amount is below USD threshold", () => {
      expect(service.requiresApproval(makeRequest({ amountCents: 9_999_99, currency: "USD" }))).toBe(false);
    });

    it("returns true when amount equals USD threshold", () => {
      expect(service.requiresApproval(makeRequest({ amountCents: DEFAULT_THRESHOLDS.USD, currency: "USD" }))).toBe(true);
    });

    it("returns true when amount exceeds USD threshold", () => {
      expect(service.requiresApproval(makeLargeRequest())).toBe(true);
    });

    it("uses GBP threshold independently", () => {
      expect(service.requiresApproval(makeRequest({ amountCents: DEFAULT_THRESHOLDS.GBP, currency: "GBP" }))).toBe(true);
      expect(service.requiresApproval(makeRequest({ amountCents: DEFAULT_THRESHOLDS.GBP - 1, currency: "GBP" }))).toBe(false);
    });

    it("never requires approval for unknown currency (no threshold = Infinity)", () => {
      expect(service.requiresApproval(makeRequest({ amountCents: 999_999_999, currency: "UNKNOWN" }))).toBe(false);
    });
  });

  // ── initiate ──────────────────────────────────────────────────────────────

  describe("initiate()", () => {
    it("auto-approves small refunds without creating a pending request", async () => {
      const result = await service.initiate(makeRequest(), "admin-a");
      expect(result.requiresApproval).toBe(false);
      expect(result.autoApproved).toBeDefined();
      expect(result.pendingRequest).toBeUndefined();
    });

    it("creates a pending request for large refunds", async () => {
      const result = await service.initiate(makeLargeRequest(), "admin-a");
      expect(result.requiresApproval).toBe(true);
      expect(result.pendingRequest).toBeDefined();
      expect(result.pendingRequest!.status).toBe("pending");
      expect(result.pendingRequest!.initiatorId).toBe("admin-a");
    });

    it("sets expiry on pending request", async () => {
      const result = await service.initiate(makeLargeRequest(), "admin-a");
      const ttl = 30 * 60 * 1000;
      expect(result.pendingRequest!.expiresAt).toBe(nowMs + ttl);
    });

    it("emits audit event for pending request", async () => {
      await service.initiate(makeLargeRequest(), "admin-a");
      expect(auditEvents.some((e) => e.action.includes("initiated"))).toBe(true);
    });

    it("emits audit event for auto-approved request", async () => {
      await service.initiate(makeRequest(), "admin-a");
      expect(auditEvents.some((e) => e.action.includes("auto_approved"))).toBe(true);
    });

    it("rejects empty initiatorId", async () => {
      await expect(service.initiate(makeLargeRequest(), "")).rejects.toThrow(RefundApprovalError);
    });
  });

  // ── approve ───────────────────────────────────────────────────────────────

  describe("approve()", () => {
    it("approves a pending request by a different admin", async () => {
      const { pendingRequest } = await service.initiate(makeLargeRequest(), "admin-a");
      const result = await service.approve(pendingRequest!.id, "admin-b");
      expect(result.approvedRequest.status).toBe("approved");
      expect(result.approvedRequest.approverId).toBe("admin-b");
      expect(result.refundRequest.amountCents).toBe(15_000_00);
    });

    it("throws SELF_APPROVAL when the initiator tries to approve", async () => {
      const { pendingRequest } = await service.initiate(makeLargeRequest(), "admin-a");
      await expect(service.approve(pendingRequest!.id, "admin-a")).rejects.toMatchObject({
        code: "SELF_APPROVAL",
      });
    });

    it("throws NOT_FOUND for unknown approvalId", async () => {
      await expect(service.approve("nonexistent", "admin-b")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("throws ALREADY_RESOLVED for already-approved request", async () => {
      const { pendingRequest } = await service.initiate(makeLargeRequest(), "admin-a");
      await service.approve(pendingRequest!.id, "admin-b");
      await expect(service.approve(pendingRequest!.id, "admin-c")).rejects.toMatchObject({
        code: "ALREADY_RESOLVED",
      });
    });

    it("emits audit event on approval", async () => {
      const { pendingRequest } = await service.initiate(makeLargeRequest(), "admin-a");
      await service.approve(pendingRequest!.id, "admin-b");
      expect(auditEvents.some((e) => e.action.includes("approved"))).toBe(true);
    });

    it("throws EXPIRED when TTL has passed", async () => {
      const svc = new PartialRefundApprovalService({
        approvalTtlMs: 1000,
        now: () => nowMs,
      });
      const { pendingRequest } = await svc.initiate(makeLargeRequest(), "admin-a");

      // Advance clock past TTL
      nowMs += 2000;
      await expect(svc.approve(pendingRequest!.id, "admin-b")).rejects.toMatchObject({
        code: "EXPIRED",
      });
    });
  });

  // ── deny ─────────────────────────────────────────────────────────────────

  describe("deny()", () => {
    it("denies a pending request", async () => {
      const { pendingRequest } = await service.initiate(makeLargeRequest(), "admin-a");
      const denied = await service.deny(pendingRequest!.id, "admin-b", "policy violation");
      expect(denied.status).toBe("denied");
      expect(denied.deniedById).toBe("admin-b");
      expect(denied.deniedReason).toBe("policy violation");
    });

    it("throws NOT_FOUND for unknown id", async () => {
      await expect(service.deny("ghost", "admin-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("throws ALREADY_RESOLVED after approval", async () => {
      const { pendingRequest } = await service.initiate(makeLargeRequest(), "admin-a");
      await service.approve(pendingRequest!.id, "admin-b");
      await expect(service.deny(pendingRequest!.id, "admin-c")).rejects.toMatchObject({
        code: "ALREADY_RESOLVED",
      });
    });

    it("emits audit event on denial", async () => {
      const { pendingRequest } = await service.initiate(makeLargeRequest(), "admin-a");
      await service.deny(pendingRequest!.id, "admin-b");
      expect(auditEvents.some((e) => e.action.includes("denied"))).toBe(true);
    });
  });

  // ── expiry ────────────────────────────────────────────────────────────────

  describe("expiry", () => {
    it("getById marks a pending request as expired after TTL", async () => {
      const svc = new PartialRefundApprovalService({
        approvalTtlMs: 5000,
        now: () => nowMs,
      });
      const { pendingRequest } = await svc.initiate(makeLargeRequest(), "admin-a");
      nowMs += 6000;

      const result = svc.getById(pendingRequest!.id);
      expect(result?.status).toBe("expired");
    });

    it("list() surfaces expired requests under 'expired' filter", async () => {
      const svc = new PartialRefundApprovalService({
        approvalTtlMs: 1000,
        now: () => nowMs,
      });
      await svc.initiate(makeLargeRequest(), "admin-a");
      nowMs += 2000;

      const expired = svc.list({ status: "expired" });
      expect(expired).toHaveLength(1);
    });
  });

  // ── list ──────────────────────────────────────────────────────────────────

  describe("list()", () => {
    it("returns all requests when no filter given", async () => {
      await service.initiate(makeLargeRequest({ paymentId: "pay-1" }), "admin-a");
      await service.initiate(makeLargeRequest({ paymentId: "pay-2" }), "admin-a");
      expect(service.list()).toHaveLength(2);
    });

    it("filters by status correctly", async () => {
      const { pendingRequest: r1 } = await service.initiate(makeLargeRequest({ paymentId: "pay-1" }), "admin-a");
      const { pendingRequest: r2 } = await service.initiate(makeLargeRequest({ paymentId: "pay-2" }), "admin-a");

      await service.approve(r1!.id, "admin-b");

      expect(service.list({ status: "pending" })).toHaveLength(1);
      expect(service.list({ status: "approved" })).toHaveLength(1);
    });
  });

  // ── custom thresholds ─────────────────────────────────────────────────────

  describe("custom thresholds", () => {
    it("respects lower per-currency threshold", async () => {
      const svc = new PartialRefundApprovalService({
        thresholds: { USD: 100_00 }, // $100
      });
      expect(svc.requiresApproval(makeRequest({ amountCents: 100_00 }))).toBe(true);
      expect(svc.requiresApproval(makeRequest({ amountCents: 99_99 }))).toBe(false);
    });
  });
});
