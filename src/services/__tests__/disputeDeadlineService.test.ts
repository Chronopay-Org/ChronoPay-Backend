/**
 * disputeDeadlineService.test.ts
 * --------------------------------
 * Pure-logic tests for src/services/disputeDeadlineService.ts.
 *
 * Covers:
 *   - OPEN / EVIDENCED → TIMEOUT (inactivity timeout)
 *   - ADJUDICATED → CLOSED (appeal window expired)
 *   - APPEALED / SENIOR_REVIEW → TIMEOUT (senior review deadline)
 *   - Terminal / already-resolved disputes are skipped
 *   - Reversal of auto-resolution
 *   - Edge cases: both parties inactive, appeal filed mid-close, timezone in deadline
 *   - Audit event emission (spy on defaultAuditLogger.log)
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import {
  scanAndAutoResolve,
  reverseAutoResolve,
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  DEFAULT_SENIOR_REVIEW_TIMEOUT_MS,
  DEFAULT_AUTO_RESOLVE_REVERSAL_WINDOW_MS,
} from "../disputeDeadlineService.js";
import { defaultAuditLogger } from "../auditLogger.js";
import type { Dispute, DisputeStatus } from "../../types/dispute.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: "dispute-1",
    status: "OPEN" as DisputeStatus,
    buyerId: "buyer-1",
    supplierId: "supplier-1",
    buyerTenantId: "tenant-buyer",
    supplierTenantId: "tenant-supplier",
    amount: 100,
    evidence: [],
    finalityHash: null,
    finalityChain: [],
    ...overrides,
  };
}

function makeOPEN(ageDays: number): Dispute {
  const now = Date.now();
  const chainTime = now - ageDays * 24 * 60 * 60 * 1000;
  return buildDispute({
    id: `dispute-open-${ageDays}`,
    status: "OPEN",
    finalityHash: "abc",
    finalityChain: [
      {
        prevHash: null,
        hash: "abc",
        status: "OPEN",
        at: chainTime,
        payload: {},
      },
    ],
  });
}

function makeEVIDENCED(ageDays: number): Dispute {
  const now = Date.now();
  const chainTime = now - ageDays * 24 * 60 * 60 * 1000;
  return buildDispute({
    id: `dispute-evidenced-${ageDays}`,
    status: "EVIDENCED",
    finalityHash: "def",
    finalityChain: [
      { prevHash: null, hash: "a", status: "OPEN", at: chainTime - 1000, payload: {} },
      { prevHash: "a", hash: "def", status: "EVIDENCED", at: chainTime, payload: {} },
    ],
  });
}

function makeADJUDICATED(ageHours: number, appealWindowMs?: number): Dispute {
  const now = Date.now();
  const adjudicatedAt = now - ageHours * 60 * 60 * 1000;
  return buildDispute({
    id: `dispute-adjudicated-${ageHours}`,
    status: "ADJUDICATED",
    ruling: "BUYER_FAVOR",
    arbiter: "arb-1",
    adjudicatedAt,
    appealWindowMs,
    finalityHash: "ghi",
    finalityChain: [
      { prevHash: null, hash: "a", status: "OPEN", at: adjudicatedAt - 2000, payload: {} },
      { prevHash: "a", hash: "b", status: "EVIDENCED", at: adjudicatedAt - 1000, payload: {} },
      { prevHash: "b", hash: "ghi", status: "ADJUDICATED", at: adjudicatedAt, payload: {} },
    ],
  });
}

function makeAPPEALED(ageDays: number): Dispute {
  const now = Date.now();
  const initiatedAt = now - ageDays * 24 * 60 * 60 * 1000;
  return buildDispute({
    id: `dispute-appealed-${ageDays}`,
    status: "APPEALED",
    adjudicatedAt: initiatedAt - 1000,
    appealInitiatedAt: initiatedAt,
    finalityHash: "jkl",
    finalityChain: [
      { prevHash: null, hash: "a", status: "OPEN", at: initiatedAt - 3000, payload: {} },
      { prevHash: "a", hash: "b", status: "EVIDENCED", at: initiatedAt - 2000, payload: {} },
      { prevHash: "b", hash: "c", status: "ADJUDICATED", at: initiatedAt - 1000, payload: {} },
      { prevHash: "c", hash: "jkl", status: "APPEALED", at: initiatedAt, payload: {} },
    ],
    panel: [{ id: "sa-1", tenantId: "neutral-A" }],
  });
}

function makeSENIOR_REVIEW(ageDays: number): Dispute {
  const now = Date.now();
  const initiatedAt = now - ageDays * 24 * 60 * 60 * 1000;
  return buildDispute({
    id: `dispute-senior-${ageDays}`,
    status: "SENIOR_REVIEW",
    adjudicatedAt: initiatedAt - 1000,
    appealInitiatedAt: initiatedAt,
    finalityHash: "mno",
    finalityChain: [
      { prevHash: null, hash: "a", status: "OPEN", at: initiatedAt - 4000, payload: {} },
      { prevHash: "a", hash: "b", status: "EVIDENCED", at: initiatedAt - 3000, payload: {} },
      { prevHash: "b", hash: "c", status: "ADJUDICATED", at: initiatedAt - 2000, payload: {} },
      { prevHash: "c", hash: "d", status: "APPEALED", at: initiatedAt - 1000, payload: {} },
      { prevHash: "d", hash: "mno", status: "SENIOR_REVIEW", at: initiatedAt, payload: {} },
    ],
    panel: [{ id: "sa-1", tenantId: "neutral-A" }],
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(defaultAuditLogger, "log").mockImplementation(() => Promise.resolve());
});

// ---------------------------------------------------------------------------
// scanAndAutoResolve
// ---------------------------------------------------------------------------

describe("scanAndAutoResolve", () => {
  it("auto-resolves OPEN disputes inactive beyond the timeout to TIMEOUT", () => {
    const oldDispute = makeOPEN(DEFAULT_INACTIVITY_TIMEOUT_MS / (24 * 60 * 60 * 1000) + 1);
    const freshDispute = makeOPEN(1); // only 1 day old — should skip

    const result = scanAndAutoResolve([oldDispute, freshDispute]);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].disputeId).toBe(oldDispute.id);
    expect(result.resolved[0].fromStatus).toBe("OPEN");
    expect(result.resolved[0].toStatus).toBe("TIMEOUT");
    expect(result.resolved[0].ruling).toBe("TIMEOUT_NO_ACTIVITY");
    expect(result.skipped).toBe(1);

    // Verify the dispute was mutated in-place
    expect(oldDispute.status).toBe("TIMEOUT");
    expect(oldDispute.autoResolvedAt).toBeGreaterThan(0);
    expect(oldDispute.autoResolveWindowMs).toBe(DEFAULT_AUTO_RESOLVE_REVERSAL_WINDOW_MS);
  });

  it("auto-resolves EVIDENCED disputes inactive beyond the timeout to TIMEOUT", () => {
    const oldDispute = makeEVIDENCED(DEFAULT_INACTIVITY_TIMEOUT_MS / (24 * 60 * 60 * 1000) + 2);

    const result = scanAndAutoResolve([oldDispute]);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].fromStatus).toBe("EVIDENCED");
    expect(result.resolved[0].toStatus).toBe("TIMEOUT");
    expect(oldDispute.status).toBe("TIMEOUT");
  });

  it("auto-resolves ADJUDICATED disputes past the appeal window to CLOSED", () => {
    // Default appeal window is 72h; create a dispute adjudicated 96h ago
    const oldDispute = makeADJUDICATED(96);

    const result = scanAndAutoResolve([oldDispute]);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].fromStatus).toBe("ADJUDICATED");
    expect(result.resolved[0].toStatus).toBe("CLOSED");
    expect(result.resolved[0].ruling).toBe("BUYER_FAVOR");
    expect(oldDispute.status).toBe("CLOSED");
  });

  it("honours per-dispute appealWindowMs override when scanning", () => {
    // Short appeal window (1 hour), dispute was adjudicated 2 hours ago
    const dispute = makeADJUDICATED(2, 60 * 60 * 1000);

    const result = scanAndAutoResolve([dispute]);

    expect(result.resolved).toHaveLength(1);
    expect(dispute.status).toBe("CLOSED");
  });

  it("does not close ADJUDICATED disputes still within the appeal window", () => {
    const freshDispute = makeADJUDICATED(24); // 24h ago, default window 72h

    const result = scanAndAutoResolve([freshDispute]);

    expect(result.resolved).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(freshDispute.status).toBe("ADJUDICATED");
  });

  it("auto-resolves APPEALED disputes past the senior review deadline to CLOSED", () => {
    const oldDispute = makeAPPEALED(
      DEFAULT_SENIOR_REVIEW_TIMEOUT_MS / (24 * 60 * 60 * 1000) + 1,
    );

    const result = scanAndAutoResolve([oldDispute]);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].fromStatus).toBe("APPEALED");
    expect(result.resolved[0].toStatus).toBe("CLOSED");
    expect(oldDispute.status).toBe("CLOSED");
  });

  it("auto-resolves SENIOR_REVIEW disputes past the senior review deadline to CLOSED", () => {
    const oldDispute = makeSENIOR_REVIEW(
      DEFAULT_SENIOR_REVIEW_TIMEOUT_MS / (24 * 60 * 60 * 1000) + 1,
    );

    const result = scanAndAutoResolve([oldDispute]);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].fromStatus).toBe("SENIOR_REVIEW");
    expect(result.resolved[0].toStatus).toBe("CLOSED");
    expect(oldDispute.status).toBe("CLOSED");
  });

  it("skips terminal disputes (FINAL, CLOSED, TIMEOUT)", () => {
    const terminalDisputes = [
      buildDispute({ id: "d1", status: "FINAL" }),
      buildDispute({ id: "d2", status: "CLOSED" }),
      buildDispute({ id: "d3", status: "TIMEOUT" }),
    ];

    const result = scanAndAutoResolve(terminalDisputes);

    expect(result.resolved).toHaveLength(0);
    expect(result.skipped).toBe(3);
  });

  it("skips disputes that were already auto-resolved", () => {
    const alreadyResolved = makeADJUDICATED(96);
    alreadyResolved.autoResolvedAt = Date.now() - 1000;

    const result = scanAndAutoResolve([alreadyResolved]);

    expect(result.resolved).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it("respects custom configuration options", () => {
    const now = Date.now();
    const veryShortTimeout = 60 * 60 * 1000; // 1 hour
    const dispute = makeOPEN(0.5); // 12 hours old
    // The last activity is at `now - 0.5 days` = now - 12h
    // With a 1-hour timeout, this should be resolved

    const result = scanAndAutoResolve([dispute], {
      inactivityTimeoutMs: veryShortTimeout,
      now: () => now,
    });

    expect(result.resolved).toHaveLength(1);
    expect(dispute.status).toBe("TIMEOUT");
  });

  it("emits a DISPUTE_AUTO_RESOLVED audit event for each resolved dispute", () => {
    const now = Date.now();
    const oldDispute = makeADJUDICATED(96);

    scanAndAutoResolve([oldDispute], { now: () => now });

    expect(defaultAuditLogger.log).toHaveBeenCalledWith(
      "DISPUTE_AUTO_RESOLVED",
      expect.objectContaining({
        body: expect.objectContaining({
          disputeId: oldDispute.id,
          fromStatus: "ADJUDICATED",
          toStatus: "CLOSED",
        }),
      }),
      expect.objectContaining({
        resource: `dispute:${oldDispute.id}`,
        status: "auto_resolved",
      }),
    );
  });

  it("handles mixed states with some resolvable and some not", () => {
    const now = Date.now();
    const resolvableOpen = makeOPEN(DEFAULT_INACTIVITY_TIMEOUT_MS / (24 * 60 * 60 * 1000) + 5);
    const resolvableAdjudicated = makeADJUDICATED(96);
    const freshOpen = makeOPEN(1);
    const finalDispute = buildDispute({ id: "dfinal", status: "FINAL" });

    const result = scanAndAutoResolve(
      [resolvableOpen, resolvableAdjudicated, freshOpen, finalDispute],
      { now: () => now },
    );

    expect(result.resolved).toHaveLength(2);
    expect(result.skipped).toBe(2);
  });

  it("encodes the correct ruling when APPEALED / SENIOR_REVIEW closes with existing ruling", () => {
    const now = Date.now();
    const oldAdjudicated = makeAPPEALED(
      DEFAULT_SENIOR_REVIEW_TIMEOUT_MS / (24 * 60 * 60 * 1000) + 2,
    );
    oldAdjudicated.ruling = "SUPPLIER_FAVOR";

    // Use `now` option to ensure consistent timing
    const result = scanAndAutoResolve([oldAdjudicated], { now: () => now });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].ruling).toBe("SUPPLIER_FAVOR");
  });
});

// ---------------------------------------------------------------------------
// reverseAutoResolve
// ---------------------------------------------------------------------------

describe("reverseAutoResolve", () => {
  it("reverses a recently auto-resolved dispute back to its prior status", () => {
    const now = Date.now();
    const dispute = makeADJUDICATED(96);
    // First auto-resolve it
    scanAndAutoResolve([dispute], { now: () => now });
    expect(dispute.status).toBe("CLOSED");
    expect(dispute.autoResolvedAt).toBeDefined();

    const map = new Map<string, Dispute>([[dispute.id, dispute]]);

    const result = reverseAutoResolve(map, dispute.id, { now: () => now + 1000 });

    expect(result.reversed).toBe(true);
    expect(result.dispute!.status).toBe("ADJUDICATED");
    // auto-resolve fields should be cleared
    expect((result.dispute as any).autoResolvedAt).toBeUndefined();
    expect((result.dispute as any).autoResolveWindowMs).toBeUndefined();
  });

  it("reverses an OPEN→TIMEOUT auto-resolution back to OPEN", () => {
    const now = Date.now();
    const dispute = makeOPEN(DEFAULT_INACTIVITY_TIMEOUT_MS / (24 * 60 * 60 * 1000) + 5);
    scanAndAutoResolve([dispute], { now: () => now });
    expect(dispute.status).toBe("TIMEOUT");

    const map = new Map<string, Dispute>([[dispute.id, dispute]]);

    const result = reverseAutoResolve(map, dispute.id, { now: () => now + 1000 });

    expect(result.reversed).toBe(true);
    expect(result.dispute!.status).toBe("OPEN");
  });

  it("reverses an APPEALED→CLOSED auto-resolution back to APPEALED", () => {
    const now = Date.now();
    const dispute = makeAPPEALED(
      DEFAULT_SENIOR_REVIEW_TIMEOUT_MS / (24 * 60 * 60 * 1000) + 2,
    );
    scanAndAutoResolve([dispute], { now: () => now });
    expect(dispute.status).toBe("CLOSED");

    const map = new Map<string, Dispute>([[dispute.id, dispute]]);

    const result = reverseAutoResolve(map, dispute.id, { now: () => now + 1000 });

    expect(result.reversed).toBe(true);
    expect(result.dispute!.status).toBe("APPEALED");
  });

  it("rejects reversal after the window has expired", () => {
    const now = Date.now();
    const dispute = makeADJUDICATED(96);
    scanAndAutoResolve([dispute], {
      now: () => now,
      autoResolveWindowMs: 100, // 100 ms window
    });
    expect(dispute.status).toBe("CLOSED");

    const map = new Map<string, Dispute>([[dispute.id, dispute]]);

    // After the 100 ms window expires
    const result = reverseAutoResolve(map, dispute.id, { now: () => now + 200 });

    expect(result.reversed).toBe(false);
    expect(result.error?.code).toBe("REVERSAL_WINDOW_EXPIRED");
    expect(dispute.status).toBe("CLOSED"); // unchanged
  });

  it("rejects reversal of a dispute that was not auto-resolved", () => {
    const dispute = makeADJUDICATED(24); // fresh, not auto-resolved
    const map = new Map<string, Dispute>([[dispute.id, dispute]]);

    const result = reverseAutoResolve(map, dispute.id);

    expect(result.reversed).toBe(false);
    expect(result.error?.code).toBe("NOT_AUTO_RESOLVED");
  });

  it("returns DISPUTE_NOT_FOUND for unknown dispute id", () => {
    const map = new Map<string, Dispute>();

    const result = reverseAutoResolve(map, "nonexistent");

    expect(result.reversed).toBe(false);
    expect(result.error?.code).toBe("DISPUTE_NOT_FOUND");
  });

  it("rejects reversal when dispute is not in TIMEOUT or CLOSED state", () => {
    const now = Date.now();
    const dispute = makeOPEN(1); // still OPEN, not resolved
    // Manually set auto-resolve fields to simulate bad state
    dispute.autoResolvedAt = now - 1000;
    dispute.autoResolveWindowMs = DEFAULT_AUTO_RESOLVE_REVERSAL_WINDOW_MS;

    const map = new Map<string, Dispute>([[dispute.id, dispute]]);

    const result = reverseAutoResolve(map, dispute.id, { now: () => now });

    expect(result.reversed).toBe(false);
    expect(result.error?.code).toBe("INVALID_STATE");
  });

  it("emits a DISPUTE_AUTO_RESOLVE_REVERSED audit event", () => {
    const now = Date.now();
    const dispute = makeADJUDICATED(96);
    scanAndAutoResolve([dispute], { now: () => now });

    const map = new Map<string, Dispute>([[dispute.id, dispute]]);

    jest.clearAllMocks(); // Clear the auto-resolve audit log
    jest.spyOn(defaultAuditLogger, "log").mockImplementation(() => Promise.resolve());

    reverseAutoResolve(map, dispute.id, { now: () => now + 1000 });

    expect(defaultAuditLogger.log).toHaveBeenCalledWith(
      "DISPUTE_AUTO_RESOLVE_REVERSED",
      expect.objectContaining({
        body: expect.objectContaining({
          disputeId: dispute.id,
        }),
      }),
      expect.objectContaining({
        resource: `dispute:${dispute.id}`,
        status: "reversed",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("dispute deadline edge cases", () => {
  it("handles an empty dispute list gracefully", () => {
    const result = scanAndAutoResolve([]);
    expect(result.resolved).toHaveLength(0);
    expect(result.skipped).toBe(0);
  });

  it("skips a dispute with an empty finality chain (no activity recorded yet)", () => {
    const now = Date.now();
    const dispute = buildDispute({
      id: "no-chain",
      status: "OPEN",
      finalityHash: null,
      finalityChain: [],
    });

    // Empty chain means the dispute was just created — not enough history
    // to determine inactivity. Should be skipped.
    const result = scanAndAutoResolve([dispute], {
      now: () => now,
    });

    expect(result.resolved).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(dispute.status).toBe("OPEN");
  });

  it("does not re-resolve an already-resolved dispute on a second scan", () => {
    const dispute = makeADJUDICATED(96);
    const first = scanAndAutoResolve([dispute]);
    expect(first.resolved).toHaveLength(1);

    const second = scanAndAutoResolve([dispute]);
    expect(second.resolved).toHaveLength(0);
    expect(second.skipped).toBe(1);
  });

  it("correctly computes the ruling for ADJUDICATED disputes with NO_RULING_AVAILABLE", () => {
    const now = Date.now();
    const dispute = makeADJUDICATED(96);
    delete (dispute as any).ruling;

    const result = scanAndAutoResolve([dispute], { now: () => now });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].ruling).toBe("NO_RULING_AVAILABLE");
  });

  it("does not resolve an APPEALED dispute before the senior review deadline", () => {
    const freshAppeal = makeAPPEALED(5); // 5 days old, default deadline is 14 days

    const result = scanAndAutoResolve([freshAppeal]);

    expect(result.resolved).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(freshAppeal.status).toBe("APPEALED");
  });

  it("reversal adds a finality chain link and updates finalityHash", () => {
    const now = Date.now();
    const dispute = makeADJUDICATED(96);
    scanAndAutoResolve([dispute], { now: () => now });

    const hashBeforeReversal = dispute.finalityHash;
    const chainLengthBefore = dispute.finalityChain.length;

    const map = new Map<string, Dispute>([[dispute.id, dispute]]);
    const result = reverseAutoResolve(map, dispute.id, { now: () => now + 1000 });

    expect(result.reversed).toBe(true);
    expect(result.dispute!.finalityHash).not.toBe(hashBeforeReversal);
    expect(result.dispute!.finalityChain.length).toBe(chainLengthBefore + 1);
  });

  it("uses custom senior review timeout when provided", () => {
    const now = Date.now();
    const shortTimeout = 3 * 24 * 60 * 60 * 1000; // 3 days
    const dispute = makeAPPEALED(5); // 5 days old

    const result = scanAndAutoResolve([dispute], {
      seniorReviewTimeoutMs: shortTimeout,
      now: () => now,
    });

    expect(result.resolved).toHaveLength(1);
    expect(dispute.status).toBe("CLOSED");
  });

  it("resolves disputes with timezone-relevant timestamps (millisecond precision)", () => {
    // Simulate a dispute that was adjudicated exactly at the boundary
    const now = Date.now();
    const appealWindowMs = 72 * 60 * 60 * 1000;
    const exactlyAtBoundary = makeADJUDICATED(72, appealWindowMs);
    // Make the adjudicatedAt exactly 72h ago
    exactlyAtBoundary.adjudicatedAt = now - appealWindowMs;

    const result = scanAndAutoResolve([exactlyAtBoundary], {
      now: () => now,
    });

    // At exactly the boundary, now - adjudicatedAt === appealWindowMs, so it should resolve
    expect(result.resolved).toHaveLength(1);
    expect(exactlyAtBoundary.status).toBe("CLOSED");
  });

  it("does not resolve disputes just shy of the boundary", () => {
    const now = Date.now();
    const appealWindowMs = 72 * 60 * 60 * 1000;
    const justWithin = makeADJUDICATED(71.9, appealWindowMs); // ~71.9h
    // Override adjudicatedAt to be ~71.9h ago
    justWithin.adjudicatedAt = now - appealWindowMs + 1000; // 1 second inside window

    const result = scanAndAutoResolve([justWithin], {
      now: () => now,
    });

    expect(result.resolved).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(justWithin.status).toBe("ADJUDICATED");
  });
});
