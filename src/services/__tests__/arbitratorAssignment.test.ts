/**
 * arbitratorAssignment.test.ts
 * ------------------------------
 * Unit tests for the arbitrator assignment engine.
 *
 * Coverage targets (≥95 %):
 *   - Happy-path assignment
 *   - Each COI signal type (SHARED_TENANT, PRIOR_TRANSACTION,
 *     KNOWN_AFFILIATION)
 *   - All-arbitrators-COI → null
 *   - Single eligible arbitrator
 *   - Offline arbitrator exclusion
 *   - Round-robin distribution and wrap-around
 *   - Audit logging of every skip reason
 *   - Combined COI signals on one arbitrator
 *   - Empty pool
 *   - In-memory store lifecycle (add, remove, clear)
 */

import { jest } from "@jest/globals";
import {
  RoundRobinArbitratorAssignmentEngine,
  InMemoryCoiLookupService,
  type Arbitrator,
  type CoiRelation,
  type AssignArbitratorInput,
} from "../arbitratorAssignment.js";
import { defaultAuditLogger } from "../auditLogger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DISPUTE: AssignArbitratorInput = {
  disputeId: "dispute-1",
  buyerId: "buyer-1",
  supplierId: "supplier-1",
};

function makeArb(overrides: Partial<Arbitrator> = {}): Arbitrator {
  return {
    id: "arb-alice",
    name: "Alice",
    tenantId: "tenant-neutral",
    isOnline: true,
    ...overrides,
  };
}

function makePool(...overrides: Partial<Arbitrator>[]): Arbitrator[] {
  if (overrides.length === 0) return [makeArb()];
  return overrides.map((o) => makeArb(o));
}

function makeCoiRelation(
  override: Partial<CoiRelation> = {},
): CoiRelation {
  return {
    arbitratorId: "arb-alice",
    partyId: "buyer-1",
    partyType: "buyer",
    signal: "SHARED_TENANT",
    reason: "Shared tenant tenant-conflict",
    ...override,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InMemoryCoiLookupService", () => {
  let store: InMemoryCoiLookupService;

  beforeEach(() => {
    store = new InMemoryCoiLookupService();
  });

  it("returns hasConflict=false when no relations exist", async () => {
    const result = await store.getConflicts("arb-alice", "buyer-1", "supplier-1");
    expect(result.hasConflict).toBe(false);
    expect(result.signals).toEqual([]);
  });

  it("returns hasConflict=true when a relation matches the buyer", async () => {
    store.addRelation(makeCoiRelation({ partyId: "buyer-1", partyType: "buyer" }));
    const result = await store.getConflicts("arb-alice", "buyer-1", "supplier-1");
    expect(result.hasConflict).toBe(true);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].signal).toBe("SHARED_TENANT");
  });

  it("returns hasConflict=true when a relation matches the supplier", async () => {
    store.addRelation(
      makeCoiRelation({ partyId: "supplier-1", partyType: "supplier", signal: "PRIOR_TRANSACTION" }),
    );
    const result = await store.getConflicts("arb-alice", "buyer-1", "supplier-1");
    expect(result.hasConflict).toBe(true);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].signal).toBe("PRIOR_TRANSACTION");
  });

  it("ignores relations for a different arbitrator", async () => {
    store.addRelation(makeCoiRelation({ arbitratorId: "arb-bob" }));
    const result = await store.getConflicts("arb-alice", "buyer-1", "supplier-1");
    expect(result.hasConflict).toBe(false);
  });

  it("ignores relations for a different party", async () => {
    store.addRelation(makeCoiRelation({ partyId: "other-party" }));
    const result = await store.getConflicts("arb-alice", "buyer-1", "supplier-1");
    expect(result.hasConflict).toBe(false);
  });

  it("returns multiple signals when several COI relations exist", async () => {
    store.addRelation(makeCoiRelation({ signal: "SHARED_TENANT", reason: "Shared tenant" }));
    store.addRelation(
      makeCoiRelation({ signal: "PRIOR_TRANSACTION", reason: "Prior tx", partyId: "supplier-1", partyType: "supplier" }),
    );
    const result = await store.getConflicts("arb-alice", "buyer-1", "supplier-1");
    expect(result.hasConflict).toBe(true);
    expect(result.signals).toHaveLength(2);
  });

  it("removes relations for a given arbitrator", async () => {
    store.addRelation(makeCoiRelation());
    store.removeRelationsFor("arb-alice");
    const result = await store.getConflicts("arb-alice", "buyer-1", "supplier-1");
    expect(result.hasConflict).toBe(false);
  });

  it("clears all relations", async () => {
    store.addRelation(makeCoiRelation());
    store.addRelation(makeCoiRelation({ arbitratorId: "arb-bob" }));
    store.clear();
    const r1 = await store.getConflicts("arb-alice", "buyer-1", "supplier-1");
    const r2 = await store.getConflicts("arb-bob", "buyer-1", "supplier-1");
    expect(r1.hasConflict).toBe(false);
    expect(r2.hasConflict).toBe(false);
  });
});

describe("RoundRobinArbitratorAssignmentEngine", () => {
  let engine: RoundRobinArbitratorAssignmentEngine;

  beforeEach(() => {
    jest.restoreAllMocks();
    engine = new RoundRobinArbitratorAssignmentEngine();
  });

  describe("happy path", () => {
    it("assigns the only eligible arbitrator", async () => {
      const pool = makePool();
      const result = await engine.assignArbitrator(DISPUTE, pool);

      expect(result.assigned).not.toBeNull();
      expect(result.assigned!.id).toBe("arb-alice");
      expect(result.skipped).toEqual([]);
    });

    it("assigns the first eligible arbitrator from a pool of multiple", async () => {
      const pool = [
        makeArb({ id: "arb-1", name: "One" }),
        makeArb({ id: "arb-2", name: "Two" }),
      ];
      const result = await engine.assignArbitrator(DISPUTE, pool);

      expect(result.assigned).not.toBeNull();
      expect(result.assigned!.id).toBe("arb-1");
      expect(result.skipped).toEqual([]);
    });
  });

  describe("COI exclusion", () => {
    it("skips arbitrators with SHARED_TENANT conflict against the buyer", async () => {
      const pool = [
        makeArb({ id: "arb-alice", name: "Alice", tenantId: "tenant-neutral" }),
        makeArb({ id: "arb-bob", name: "Bob", tenantId: "tenant-conflict" }),
      ];
      engine.coiLookupService.addRelation({
        arbitratorId: "arb-bob",
        partyId: "buyer-1",
        partyType: "buyer",
        signal: "SHARED_TENANT",
        reason: "Shared tenant tenant-conflict",
      });

      const result = await engine.assignArbitrator(DISPUTE, pool);

      expect(result.assigned).not.toBeNull();
      expect(result.assigned!.id).toBe("arb-alice");
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].arbitratorId).toBe("arb-bob");
      expect(result.skipped[0].reason).toBe("CONFLICT_OF_INTEREST");
    });

    it("skips arbitrators with PRIOR_TRANSACTION conflict against the supplier", async () => {
      const pool = [
        makeArb({ id: "arb-alice", name: "Alice" }),
        makeArb({ id: "arb-bob", name: "Bob" }),
      ];
      engine.coiLookupService.addRelation({
        arbitratorId: "arb-bob",
        partyId: "supplier-1",
        partyType: "supplier",
        signal: "PRIOR_TRANSACTION",
        reason: "Prior transaction with supplier-1",
      });

      const result = await engine.assignArbitrator(DISPUTE, pool);

      expect(result.assigned).not.toBeNull();
      expect(result.assigned!.id).toBe("arb-alice");
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toBe("CONFLICT_OF_INTEREST");
    });

    it("skips arbitrators with KNOWN_AFFILIATION conflict", async () => {
      const pool = [
        makeArb({ id: "arb-alice", name: "Alice" }),
        makeArb({ id: "arb-bob", name: "Bob" }),
      ];
      engine.coiLookupService.addRelation({
        arbitratorId: "arb-bob",
        partyId: "buyer-1",
        partyType: "buyer",
        signal: "KNOWN_AFFILIATION",
        reason: "Family member of buyer-1",
      });

      const result = await engine.assignArbitrator(DISPUTE, pool);

      expect(result.assigned).not.toBeNull();
      expect(result.assigned!.id).toBe("arb-alice");
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toBe("CONFLICT_OF_INTEREST");
    });

    it("skips arbitrator with multiple COI signals on the same candidate", async () => {
      const pool = [
        makeArb({ id: "arb-alice", name: "Alice" }),
        makeArb({ id: "arb-bob", name: "Bob" }),
      ];
      engine.coiLookupService.addRelation({
        arbitratorId: "arb-bob",
        partyId: "buyer-1",
        partyType: "buyer",
        signal: "SHARED_TENANT",
        reason: "Shared tenant",
      });
      engine.coiLookupService.addRelation({
        arbitratorId: "arb-bob",
        partyId: "supplier-1",
        partyType: "supplier",
        signal: "PRIOR_TRANSACTION",
        reason: "Prior tx",
      });

      const result = await engine.assignArbitrator(DISPUTE, pool);

      expect(result.assigned).not.toBeNull();
      expect(result.assigned!.id).toBe("arb-alice");
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].signals).toHaveLength(2);
    });

    it("returns null assigned when every arbitrator has a COI conflict", async () => {
      const pool = [
        makeArb({ id: "arb-alice" }),
        makeArb({ id: "arb-bob" }),
      ];
      engine.coiLookupService.addRelation({
        arbitratorId: "arb-alice",
        partyId: "buyer-1",
        partyType: "buyer",
        signal: "SHARED_TENANT",
        reason: "Shared tenant",
      });
      engine.coiLookupService.addRelation({
        arbitratorId: "arb-bob",
        partyId: "supplier-1",
        partyType: "supplier",
        signal: "PRIOR_TRANSACTION",
        reason: "Prior tx",
      });

      const result = await engine.assignArbitrator(DISPUTE, pool);

      expect(result.assigned).toBeNull();
      expect(result.skipped).toHaveLength(2);
    });
  });

  describe("offline arbitrator exclusion", () => {
    it("skips offline arbitrators", async () => {
      const pool = [
        makeArb({ id: "arb-online", isOnline: true }),
        makeArb({ id: "arb-offline", isOnline: false }),
      ];
      const result = await engine.assignArbitrator(DISPUTE, pool);

      expect(result.assigned).not.toBeNull();
      expect(result.assigned!.id).toBe("arb-online");
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].arbitratorId).toBe("arb-offline");
      expect(result.skipped[0].reason).toBe("ARBITRATOR_OFFLINE");
    });

    it("skips offline arbitrators before checking COI (short-circuit)", async () => {
      // Relation exists for the offline arbitrator, but she is skipped
      // as OFFLINE before the COI lookup runs.
      const pool = [makeArb({ id: "arb-offline", isOnline: false })];
      engine.coiLookupService.addRelation({
        arbitratorId: "arb-offline",
        partyId: "buyer-1",
        partyType: "buyer",
        signal: "SHARED_TENANT",
        reason: "Would conflict but is offline first",
      });

      const result = await engine.assignArbitrator(DISPUTE, pool);

      expect(result.assigned).toBeNull();
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toBe("ARBITRATOR_OFFLINE");
    });

    it("returns null when all arbitrators are offline", async () => {
      const pool = [
        makeArb({ id: "arb-1", isOnline: false }),
        makeArb({ id: "arb-2", isOnline: false }),
      ];
      const result = await engine.assignArbitrator(DISPUTE, pool);

      expect(result.assigned).toBeNull();
      expect(result.skipped).toHaveLength(2);
    });
  });

  describe("round-robin load balancing", () => {
    it("rotates through eligible arbitrators with each call", async () => {
      const pool = [
        makeArb({ id: "arb-1", name: "One" }),
        makeArb({ id: "arb-2", name: "Two" }),
        makeArb({ id: "arb-3", name: "Three" }),
      ];

      const r1 = await engine.assignArbitrator(DISPUTE, pool);
      expect(r1.assigned!.id).toBe("arb-1");

      const r2 = await engine.assignArbitrator(DISPUTE, pool);
      expect(r2.assigned!.id).toBe("arb-2");

      const r3 = await engine.assignArbitrator(DISPUTE, pool);
      expect(r3.assigned!.id).toBe("arb-3");
    });

    it("wraps around after exhausting the pool", async () => {
      const pool = [
        makeArb({ id: "arb-1", name: "One" }),
        makeArb({ id: "arb-2", name: "Two" }),
      ];

      const r1 = await engine.assignArbitrator(DISPUTE, pool);
      const r2 = await engine.assignArbitrator(DISPUTE, pool);
      const r3 = await engine.assignArbitrator(DISPUTE, pool);

      // After two rounds, the third call wraps back to arb-1
      expect(r1.assigned!.id).toBe("arb-1");
      expect(r2.assigned!.id).toBe("arb-2");
      expect(r3.assigned!.id).toBe("arb-1");
    });

    it("tracks round-robin index across calls", async () => {
      const pool = [
        makeArb({ id: "arb-1" }),
        makeArb({ id: "arb-2" }),
      ];

      const r1 = await engine.assignArbitrator(DISPUTE, pool);
      expect(r1.roundRobinIndex).toBe(0);

      const r2 = await engine.assignArbitrator(DISPUTE, pool);
      expect(r2.roundRobinIndex).toBe(1);
    });

    it("does not count skipped arbitrators in round-robin rotation", async () => {
      const pool = [
        makeArb({ id: "arb-1", isOnline: false }),
        makeArb({ id: "arb-2", name: "Two" }),
        makeArb({ id: "arb-3", name: "Three" }),
      ];

      // Only arb-2 and arb-3 are eligible; arb-1 is offline.
      const r1 = await engine.assignArbitrator(DISPUTE, pool);
      expect(r1.assigned!.id).toBe("arb-2");
      expect(r1.skipped).toHaveLength(1);

      const r2 = await engine.assignArbitrator(DISPUTE, pool);
      expect(r2.assigned!.id).toBe("arb-3");

      const r3 = await engine.assignArbitrator(DISPUTE, pool);
      expect(r3.assigned!.id).toBe("arb-2");
    });
  });

  describe("empty pool", () => {
    it("returns null assigned when pool is empty", async () => {
      const result = await engine.assignArbitrator(DISPUTE, []);
      expect(result.assigned).toBeNull();
      expect(result.skipped).toEqual([]);
    });
  });

  describe("single eligible arbitrator", () => {
    it("assigns the same arbitrator on consecutive calls (round-robin has only one slot)", async () => {
      const pool = [makeArb({ id: "arb-only" })];
      const r1 = await engine.assignArbitrator(DISPUTE, pool);
      const r2 = await engine.assignArbitrator(DISPUTE, pool);

      expect(r1.assigned!.id).toBe("arb-only");
      expect(r2.assigned!.id).toBe("arb-only");
    });
  });

  describe("resetRoundRobin", () => {
    it("resets the round-robin counter back to zero", async () => {
      const pool = [
        makeArb({ id: "arb-1" }),
        makeArb({ id: "arb-2" }),
      ];

      await engine.assignArbitrator(DISPUTE, pool); // selects arb-1, index → 1
      engine.resetRoundRobin();
      expect(engine.getRoundRobinIndex()).toBe(0);
      const r = await engine.assignArbitrator(DISPUTE, pool);
      expect(r.assigned!.id).toBe("arb-1"); // starts from zero again
      expect(r.roundRobinIndex).toBe(0);
    });
  });

  describe("audit logging", () => {
    it("logs ARBITRATOR_SKIPPED for each excluded candidate", async () => {
      const logSpy = jest
        .spyOn(defaultAuditLogger, "log")
        .mockImplementation(() => Promise.resolve());

      const pool = [
        makeArb({ id: "arb-1", isOnline: false }),
        makeArb({ id: "arb-2" }),
      ];
      engine.coiLookupService.addRelation({
        arbitratorId: "arb-2",
        partyId: "buyer-1",
        partyType: "buyer",
        signal: "SHARED_TENANT",
        reason: "Shared tenant",
      });

      const result = await engine.assignArbitrator(DISPUTE, pool);
      expect(result.assigned).toBeNull();
      expect(result.skipped).toHaveLength(2);

      expect(logSpy).toHaveBeenCalledWith(
        "ARBITRATOR_SKIPPED",
        expect.objectContaining({
          context: expect.objectContaining({
            arbitratorId: "arb-1",
            reason: "ARBITRATOR_OFFLINE",
          }),
        }),
        expect.objectContaining({ status: "skipped" }),
      );

      expect(logSpy).toHaveBeenCalledWith(
        "ARBITRATOR_SKIPPED",
        expect.objectContaining({
          context: expect.objectContaining({
            arbitratorId: "arb-2",
            reason: "CONFLICT_OF_INTEREST",
          }),
        }),
        expect.objectContaining({ status: "skipped" }),
      );
    });

    it("logs ARBITRATOR_ASSIGNED for a successful assignment", async () => {
      const logSpy = jest
        .spyOn(defaultAuditLogger, "log")
        .mockImplementation(() => Promise.resolve());

      await engine.assignArbitrator(DISPUTE, [makeArb({ id: "arb-only" })]);

      expect(logSpy).toHaveBeenCalledWith(
        "ARBITRATOR_ASSIGNED",
        expect.objectContaining({
          context: expect.objectContaining({
            arbitratorId: "arb-only",
            disputeId: "dispute-1",
            eligibleCount: 1,
            skippedCount: 0,
          }),
        }),
        expect.objectContaining({ status: "assigned" }),
      );
    });
  });

  describe("constructor customization", () => {
    it("accepts a custom COI lookup service", async () => {
      const customStore = new InMemoryCoiLookupService();
      const customEngine = new RoundRobinArbitratorAssignmentEngine(customStore);

      expect(customEngine.coiLookupService).toBe(customStore);
    });

    it("uses the supplied logger parameter when one is passed", async () => {
      const logSpy = jest
        .spyOn(defaultAuditLogger, "log")
        .mockImplementation(() => Promise.resolve());

      // Use the default logger which is already spied on
      const customEngine = new RoundRobinArbitratorAssignmentEngine(
        undefined,
        defaultAuditLogger,
      );

      await customEngine.assignArbitrator(DISPUTE, [makeArb({ id: "arb-only" })]);

      expect(logSpy).toHaveBeenCalledWith(
        "ARBITRATOR_ASSIGNED",
        expect.objectContaining({
          context: expect.objectContaining({ arbitratorId: "arb-only" }),
        }),
        expect.any(Object),
      );
    });
  });
});
