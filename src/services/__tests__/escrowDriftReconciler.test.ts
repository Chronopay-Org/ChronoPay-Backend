import {  describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  EscrowDriftReconciler,
  driftEvents,
  mapChainEventToIntentStatus,
  type LocalStateRepository,
  type LocalSlotState,
} from "../escrowDriftReconciler.js";
import { EscrowReaderPool, readerPoolEvents } from "../escrowReaderPool.js";
import type { IEscrowReader, SlotEscrowState, EscrowStateSnapshot, EscrowLedgerInfo } from "../escrowReader.js";
import {
  
} from "../../metrics.js";

// ── Fake Escrow Reader ───────────────────────────────────────────────────────

class FakeEscrowReader implements IEscrowReader {
  public id: string;
  private snapshots: EscrowStateSnapshot[] = [];
  private failNext = false;
  private delayMs = 0;
  private _ledgerSeq: number = 1000;

  constructor(id: string) {
    this.id = id;
  }

  scriptSnapshot(snapshot: EscrowStateSnapshot): void {
    this.snapshots.push(snapshot);
  }

  failNextSnapshot(): void {
    this.failNext = true;
  }

  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  setLatestLedgerSeq(seq: number): void {
    this._ledgerSeq = seq;
  }

  async getSlotEvents(_slotId: string, _startLedger?: number): Promise<never[]> {
    return [];
  }

  async getLatestLedger(): Promise<EscrowLedgerInfo> {
    return {
      latestLedgerSeq: this._ledgerSeq,
      latestCloseTime: new Date().toISOString(),
      protocolVersion: 21,
    };
  }

  async snapshot(slotIds: string[], _startLedger?: number): Promise<EscrowStateSnapshot> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error(`[${this.id}] Simulated transport failure`);
    }

    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    const scripted = this.snapshots.shift();
    if (scripted) return scripted;

    return {
      slots: slotIds.map((slotId) => ({
        slotId,
        latestEventKind: null,
        latestTxHash: null,
        latestLedgerSeq: -1,
        bookingIntentId: null,
        eventCount: 0,
      })),
      ledgerInfo: await this.getLatestLedger(),
      readAt: new Date().toISOString(),
      readerId: this.id,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSlotState(
  slotId: string,
  overrides: Partial<SlotEscrowState> = {},
): SlotEscrowState {
  return {
    slotId,
    latestEventKind: null,
    latestTxHash: null,
    latestLedgerSeq: -1,
    bookingIntentId: null,
    eventCount: 0,
    ...overrides,
  };
}

function makeSnapshot(
  readerId: string,
  slots: SlotEscrowState[],
): EscrowStateSnapshot {
  return {
    slots,
    ledgerInfo: {
      latestLedgerSeq: 1000,
      latestCloseTime: new Date().toISOString(),
    },
    readAt: new Date().toISOString(),
    readerId,
  };
}

// ── Fake Local State Repository ──────────────────────────────────────────────

class FakeLocalStateRepo implements LocalStateRepository {
  private states = new Map<string, LocalSlotState>();
  private activeSlotIds: string[] = [];

  setActiveSlotIds(ids: string[]): void {
    this.activeSlotIds = ids;
  }

  setSlotState(slotId: string, state: LocalSlotState): void {
    this.states.set(slotId, state);
  }

  async getActiveSlotIds(): Promise<string[]> {
    return [...this.activeSlotIds];
  }

  async getSlotState(slotId: string): Promise<LocalSlotState | null> {
    return this.states.get(slotId) ?? null;
  }

  async applyOverride(
    slotId: string,
    targetStatus: "pending" | "confirmed" | "cancelled" | "expired",
    _reason: string,
  ): Promise<LocalSlotState> {
    const existing = this.states.get(slotId);
    const updated: LocalSlotState = {
      slotId,
      intentStatus: targetStatus,
      lastKnownTxHash: existing?.lastKnownTxHash ?? null,
      lastKnownEventKind: existing?.lastKnownEventKind ?? null,
    };
    this.states.set(slotId, updated);
    return updated;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("mapChainEventToIntentStatus", () => {
  it("maps Held → confirmed", () => {
    expect(mapChainEventToIntentStatus("Held")).toBe("confirmed");
  });

  it("maps Released → cancelled", () => {
    expect(mapChainEventToIntentStatus("Released")).toBe("cancelled");
  });

  it("maps Refunded → cancelled", () => {
    expect(mapChainEventToIntentStatus("Refunded")).toBe("cancelled");
  });

  it("maps Slashed → expired", () => {
    expect(mapChainEventToIntentStatus("Slashed")).toBe("expired");
  });

  it("maps null → null", () => {
    expect(mapChainEventToIntentStatus(null)).toBeNull();
  });

  it("maps unknown kind → null", () => {
    expect(mapChainEventToIntentStatus("Ransomware")).toBeNull();
  });
});

describe("EscrowReaderPool", () => {
  let readers: FakeEscrowReader[];
  let pool: EscrowReaderPool;

  beforeEach(() => {
    readers = [
      new FakeEscrowReader("reader-1"),
      new FakeEscrowReader("reader-2"),
      new FakeEscrowReader("reader-3"),
    ];
    pool = new EscrowReaderPool({
      readers,
      quorumThreshold: 0.5,
      disagreementThreshold: 0.25,
    });
    readerPoolEvents.removeAllListeners();
  });

  it("requires at least 3 readers", () => {
    expect(
      () => new EscrowReaderPool({ readers: [new FakeEscrowReader("r1"), new FakeEscrowReader("r2")] }),
    ).toThrow("at least 3 readers");
  });

  it("returns correct reader count", () => {
    expect(pool.readerCount).toBe(3);
  });

  it("builds consensus when all readers agree", async () => {
    const heldState = makeSlotState("slot-1", {
      latestEventKind: "Held",
      latestTxHash: "a".repeat(64),
      latestLedgerSeq: 100,
      eventCount: 1,
    });

    for (const reader of readers) {
      reader.scriptSnapshot(makeSnapshot(reader.id, [heldState]));
    }

    const result = await pool.vote(["slot-1"]);
    expect(result.healthyReaderCount).toBe(3);
    expect(result.failedReaderIds).toHaveLength(0);
    expect(result.slotComparisons[0].consensus).toBe(true);
    expect(result.slotComparisons[0].majorityState?.latestEventKind).toBe("Held");
    expect(result.slotComparisons[0].agreeingReaders).toBe(3);
    expect(result.slotComparisons[0].disagreementExceededThreshold).toBe(false);
  });

  it("detects reader disagreement", async () => {
    readers[0].scriptSnapshot(
      makeSnapshot("reader-1", [makeSlotState("slot-1", { latestEventKind: "Held", latestTxHash: "a".repeat(64), latestLedgerSeq: 100 })])
    );
    readers[1].scriptSnapshot(
      makeSnapshot("reader-2", [makeSlotState("slot-1", { latestEventKind: "Held", latestTxHash: "a".repeat(64), latestLedgerSeq: 100 })])
    );
    readers[2].scriptSnapshot(
      makeSnapshot("reader-3", [makeSlotState("slot-1", { latestEventKind: "Released", latestTxHash: "b".repeat(64), latestLedgerSeq: 101 })])
    );

    const alertPromise = new Promise<any>((resolve) => {
      readerPoolEvents.once("alert", resolve);
    });

    const result = await pool.vote(["slot-1"]);
    expect(result.slotComparisons[0].consensus).toBe(false);
    expect(result.slotComparisons[0].majorityState?.latestEventKind).toBe("Held");
    expect(result.slotComparisons[0].agreeingReaders).toBe(2);
    expect(result.slotComparisons[0].disagreementExceededThreshold).toBe(true);

    const alert = await alertPromise;
    expect(alert.type).toBe("READER_DISAGREEMENT");
    expect(alert.slotId).toBe("slot-1");
  });

  it("detects hung jury when no majority exists", async () => {
    readers[0].scriptSnapshot(
      makeSnapshot("reader-1", [makeSlotState("slot-1", { latestEventKind: "Held", latestTxHash: "a".repeat(64), latestLedgerSeq: 100 })])
    );
    readers[1].scriptSnapshot(
      makeSnapshot("reader-2", [makeSlotState("slot-1", { latestEventKind: "Released", latestTxHash: "b".repeat(64), latestLedgerSeq: 101 })])
    );
    readers[2].scriptSnapshot(
      makeSnapshot("reader-3", [makeSlotState("slot-1", { latestEventKind: "Refunded", latestTxHash: "c".repeat(64), latestLedgerSeq: 102 })])
    );

    const alertPromise = new Promise<any>((resolve) => {
      readerPoolEvents.once("alert", resolve);
    });

    const result = await pool.vote(["slot-1"]);
    expect(result.slotComparisons[0].consensus).toBe(false);
    expect(result.slotComparisons[0].majorityState).toBeNull();

    const alert = await alertPromise;
    expect(alert.type).toBe("HUNG_JURY");
  });

  it("excludes failed readers from quorum", async () => {
    readers[1].failNextSnapshot();

    const heldState = makeSlotState("slot-1", {
      latestEventKind: "Held",
      latestTxHash: "a".repeat(64),
      latestLedgerSeq: 100,
    });
    readers[0].scriptSnapshot(makeSnapshot("reader-1", [heldState]));
    readers[2].scriptSnapshot(makeSnapshot("reader-3", [heldState]));

    const result = await pool.vote(["slot-1"]);
    expect(result.healthyReaderCount).toBe(2);
    expect(result.failedReaderIds).toEqual(["reader-2"]);
    expect(result.slotComparisons[0].consensus).toBe(true);
    expect(result.slotComparisons[0].agreeingReaders).toBe(2);
  });

  it("handles all readers failing", async () => {
    for (const reader of readers) {
      reader.failNextSnapshot();
    }

    const result = await pool.vote(["slot-1"]);
    expect(result.healthyReaderCount).toBe(0);
    expect(result.failedReaderIds).toEqual(["reader-1", "reader-2", "reader-3"]);
    expect(result.slotComparisons[0].majorityState).toBeNull();
  });

  it("evaluates multiple slots correctly", async () => {
    const slot1State = makeSlotState("slot-1", { latestEventKind: "Held", latestTxHash: "a".repeat(64), latestLedgerSeq: 100 });
    const slot2State = makeSlotState("slot-2", { latestEventKind: "Released", latestTxHash: "b".repeat(64), latestLedgerSeq: 101 });

    for (const reader of readers) {
      reader.scriptSnapshot(makeSnapshot(reader.id, [slot1State, slot2State]));
    }

    const result = await pool.vote(["slot-1", "slot-2"]);
    expect(result.totalSlots).toBe(2);
    expect(result.slotComparisons[0].consensus).toBe(true);
    expect(result.slotComparisons[1].consensus).toBe(true);
  });
});

describe("EscrowDriftReconciler", () => {
  let readers: FakeEscrowReader[];
  let pool: EscrowReaderPool;
  let localRepo: FakeLocalStateRepo;
  let reconciler: EscrowDriftReconciler;

  beforeEach(() => {
    readers = [
      new FakeEscrowReader("reader-1"),
      new FakeEscrowReader("reader-2"),
      new FakeEscrowReader("reader-3"),
    ];
    pool = new EscrowReaderPool({
      readers,
      quorumThreshold: 0.5,
      disagreementThreshold: 0.25,
    });
    localRepo = new FakeLocalStateRepo();
    reconciler = new EscrowDriftReconciler({
      readerPool: pool,
      localRepo,
      pollIntervalMs: 60000,
      autoResolve: false,
    });
    driftEvents.removeAllListeners();
    readerPoolEvents.removeAllListeners();
  });

  afterEach(() => {
    reconciler.stop();
  });

  it("starts and stops without error", () => {
    reconciler.start();
    // @ts-expect-error - checking private state
    expect(reconciler.isRunning).toBe(true);
    reconciler.stop();
    // @ts-expect-error - checking private state
    expect(reconciler.isRunning).toBe(false);
  });

  it("handles empty active slot list gracefully", async () => {
    localRepo.setActiveSlotIds([]);
    const result = await reconciler.reconcile();
    expect(result.slotsEvaluated).toBe(0);
    expect(result.slotsInSync).toBe(0);
    expect(result.driftedSlots).toHaveLength(0);
  });

  // ── No drift scenarios ────────────────────────────────────────────────────

  it("detects no drift when chain and local DB agree (Held → confirmed)", async () => {
    const slotState = makeSlotState("slot-1", {
      latestEventKind: "Held",
      latestTxHash: "a".repeat(64),
      latestLedgerSeq: 100,
    });
    for (const reader of readers) {
      reader.scriptSnapshot(makeSnapshot(reader.id, [slotState]));
    }
    localRepo.setActiveSlotIds(["slot-1"]);
    localRepo.setSlotState("slot-1", {
      slotId: "slot-1",
      intentStatus: "confirmed",
      lastKnownTxHash: "a".repeat(64),
      lastKnownEventKind: "Held",
    });

    const result = await reconciler.reconcile();
    expect(result.slotsEvaluated).toBe(1);
    expect(result.slotsInSync).toBe(1);
    expect(result.driftedSlots).toHaveLength(0);
  });

  it("detects no drift when chain and local DB agree (Released → cancelled)", async () => {
    const slotState = makeSlotState("slot-1", {
      latestEventKind: "Released",
      latestTxHash: "b".repeat(64),
      latestLedgerSeq: 101,
    });
    for (const reader of readers) {
      reader.scriptSnapshot(makeSnapshot(reader.id, [slotState]));
    }
    localRepo.setActiveSlotIds(["slot-1"]);
    localRepo.setSlotState("slot-1", {
      slotId: "slot-1",
      intentStatus: "cancelled",
      lastKnownTxHash: "b".repeat(64),
      lastKnownEventKind: "Released",
    });

    const result = await reconciler.reconcile();
    expect(result.slotsInSync).toBe(1);
    expect(result.driftedSlots).toHaveLength(0);
  });

  it("detects no drift when both chain and local have no events", async () => {
    for (const reader of readers) {
      reader.scriptSnapshot(makeSnapshot(reader.id, [makeSlotState("slot-1")]));
    }
    localRepo.setActiveSlotIds(["slot-1"]);
    localRepo.setSlotState("slot-1", {
      slotId: "slot-1",
      intentStatus: "pending",
      lastKnownTxHash: null,
      lastKnownEventKind: null,
    });

    const result = await reconciler.reconcile();
    expect(result.slotsInSync).toBe(1);
  });

  // ── Drift scenarios ───────────────────────────────────────────────────────

  it("detects drift: chain has events, DB has none (structural drift)", async () => {
    const slotState = makeSlotState("slot-1", {
      latestEventKind: "Held",
      latestTxHash: "a".repeat(64),
      latestLedgerSeq: 100,
    });
    for (const reader of readers) {
      reader.scriptSnapshot(makeSnapshot(reader.id, [slotState]));
    }
    localRepo.setActiveSlotIds(["slot-1"]);
    localRepo.setSlotState("slot-1", {
      slotId: "slot-1",
      intentStatus: "pending",
      lastKnownTxHash: null,
      lastKnownEventKind: null,
    });

    const alertPromise = new Promise<any>((resolve) => {
      driftEvents.once("alert", resolve);
    });

    const result = await reconciler.reconcile();
    expect(result.slotsInSync).toBe(0);
    expect(result.driftedSlots).toHaveLength(1);
    expect(result.driftedSlots[0].slotId).toBe("slot-1");
    expect(result.driftedSlots[0].description).toContain("DB has no escrow events");

    const alert = await alertPromise;
    expect(alert.type).toBe("DRIFT_DETECTED");
  });

  it("detects drift: tx hash mismatch between chain and DB", async () => {
    const slotState = makeSlotState("slot-1", {
      latestEventKind: "Held",
      latestTxHash: "a".repeat(64),
      latestLedgerSeq: 100,
    });
    for (const reader of readers) {
      reader.scriptSnapshot(makeSnapshot(reader.id, [slotState]));
    }
    localRepo.setActiveSlotIds(["slot-1"]);
    localRepo.setSlotState("slot-1", {
      slotId: "slot-1",
      intentStatus: "confirmed",
      lastKnownTxHash: "b".repeat(64),
      lastKnownEventKind: "Held",
    });

    const result = await reconciler.reconcile();
    expect(result.driftedSlots).toHaveLength(1);
    expect(result.driftedSlots[0].description).toContain("Tx hash mismatch");
  });

  it("detects drift: DB ahead of chain (local has events, chain has none)", async () => {
    for (const reader of readers) {
      reader.scriptSnapshot(makeSnapshot(reader.id, [makeSlotState("slot-1")]));
    }
    localRepo.setActiveSlotIds(["slot-1"]);
    localRepo.setSlotState("slot-1", {
      slotId: "slot-1",
      intentStatus: "confirmed",
      lastKnownTxHash: "a".repeat(64),
      lastKnownEventKind: "Held",
    });

    const result = await reconciler.reconcile();
    expect(result.driftedSlots).toHaveLength(1);
    expect(result.driftedSlots[0].description).toContain("possible reorg");
  });

  it("detects drift: intent status mismatch (same tx, diverging projection)", async () => {
    const slotState = makeSlotState("slot-1", {
      latestEventKind: "Slashed",
      latestTxHash: "a".repeat(64),
      latestLedgerSeq: 103,
    });
    for (const reader of readers) {
      reader.scriptSnapshot(makeSnapshot(reader.id, [slotState]));
    }
    localRepo.setActiveSlotIds(["slot-1"]);
    localRepo.setSlotState("slot-1", {
      slotId: "slot-1",
      intentStatus: "confirmed",
      lastKnownTxHash: "a".repeat(64),
      lastKnownEventKind: "Held",
    });

    const result = await reconciler.reconcile();
    expect(result.driftedSlots).toHaveLength(1);
    expect(result.driftedSlots[0].description).toContain("Intent status mismatch");
  });

  // ── Hung jury ─────────────────────────────────────────────────────────────

  it("flags slot as drifted when hung jury (no quorum)", async () => {
    readers[0].scriptSnapshot(
      makeSnapshot("reader-1", [makeSlotState("slot-1", { latestEventKind: "Held", latestTxHash: "a".repeat(64), latestLedgerSeq: 100 })])
    );
    readers[1].scriptSnapshot(
      makeSnapshot("reader-2", [makeSlotState("slot-1", { latestEventKind: "Released", latestTxHash: "b".repeat(64), latestLedgerSeq: 101 })])
    );
    readers[2].scriptSnapshot(
      makeSnapshot("reader-3", [makeSlotState("slot-1", { latestEventKind: "Refunded", latestTxHash: "c".repeat(64), latestLedgerSeq: 102 })])
    );

    localRepo.setActiveSlotIds(["slot-1"]);
    localRepo.setSlotState("slot-1", {
      slotId: "slot-1",
      intentStatus: "pending",
      lastKnownTxHash: null,
      lastKnownEventKind: null,
    });

    const result = await reconciler.reconcile();
    expect(result.driftedSlots).toHaveLength(1);
    expect(result.driftedSlots[0].description).toContain("No quorum");
  });

  // ── Reader failures ───────────────────────────────────────────────────────

  it("handles one reader being down", async () => {
    readers[0].failNextSnapshot();
    const slotState = makeSlotState("slot-1", {
      latestEventKind: "Held",
      latestTxHash: "a".repeat(64),
      latestLedgerSeq: 100,
    });
    readers[1].scriptSnapshot(makeSnapshot("reader-2", [slotState]));
    readers[2].scriptSnapshot(makeSnapshot("reader-3", [slotState]));

    localRepo.setActiveSlotIds(["slot-1"]);
    localRepo.setSlotState("slot-1", {
      slotId: "slot-1",
      intentStatus: "confirmed",
      lastKnownTxHash: "a".repeat(64),
      lastKnownEventKind: "Held",
    });

    const result = await reconciler.reconcile();
    expect(result.readerFailures).toBe(1);
    expect(result.slotsInSync).toBe(1);
  });

  it("handles local repo error gracefully", async () => {
    const originalGet = localRepo.getActiveSlotIds;
    localRepo.getActiveSlotIds = () => {
      throw new Error("DB connection lost");
    };

    const result = await reconciler.reconcile();
    expect(result.slotsEvaluated).toBe(0);
    expect(result.slotsInSync).toBe(0);
    expect(result.driftedSlots).toHaveLength(0);

    localRepo.getActiveSlotIds = originalGet;
  });

  // ── Manual override ───────────────────────────────────────────────────────

  it("applies manual override and emits events", async () => {
    localRepo.setActiveSlotIds(["slot-1"]);
    localRepo.setSlotState("slot-1", {
      slotId: "slot-1",
      intentStatus: "pending",
      lastKnownTxHash: null,
      lastKnownEventKind: null,
    });

    const alertPromise = new Promise<any>((resolve) => {
      driftEvents.once("alert", resolve);
    });

    const result = await reconciler.manualOverride(
      "slot-1",
      "confirmed",
      "Manual fix after quorum confirmed chain state was Held",
      "192.168.1.1",
    );

    expect(result.previousState?.intentStatus).toBe("pending");
    expect(result.newState.intentStatus).toBe("confirmed");

    const alert = await alertPromise;
    expect(alert.type).toBe("MANUAL_OVERRIDE_APPLIED");
    expect(alert.slotId).toBe("slot-1");
    expect(alert.previousStatus).toBe("pending");
    expect(alert.newStatus).toBe("confirmed");

    const updated = await localRepo.getSlotState("slot-1");
    expect(updated?.intentStatus).toBe("confirmed");
  });

  // ── autoResolve safety ────────────────────────────────────────────────────

  it("does not auto-apply drift resolution when autoResolve is false", async () => {
    const slotState = makeSlotState("slot-1", {
      latestEventKind: "Held",
      latestTxHash: "a".repeat(64),
      latestLedgerSeq: 100,
    });
    for (const reader of readers) {
      reader.scriptSnapshot(makeSnapshot(reader.id, [slotState]));
    }
    localRepo.setActiveSlotIds(["slot-1"]);
    localRepo.setSlotState("slot-1", {
      slotId: "slot-1",
      intentStatus: "pending",
      lastKnownTxHash: null,
      lastKnownEventKind: null,
    });

    await reconciler.reconcile();

    // Drift should be detected but local state should NOT change
    const state = await localRepo.getSlotState("slot-1");
    expect(state?.intentStatus).toBe("pending");
  });

  // ── Multiple slots ────────────────────────────────────────────────────────

  it("handles mixed drift across multiple slots", async () => {
    const slot1Chain = makeSlotState("slot-1", {
      latestEventKind: "Held",
      latestTxHash: "a".repeat(64),
      latestLedgerSeq: 100,
    });
    const slot2Chain = makeSlotState("slot-2", {
      latestEventKind: "Released",
      latestTxHash: "b".repeat(64),
      latestLedgerSeq: 101,
    });

    for (const reader of readers) {
      reader.scriptSnapshot(makeSnapshot(reader.id, [slot1Chain, slot2Chain]));
    }

    localRepo.setActiveSlotIds(["slot-1", "slot-2"]);
    localRepo.setSlotState("slot-1", {
      slotId: "slot-1",
      intentStatus: "confirmed",
      lastKnownTxHash: "a".repeat(64),
      lastKnownEventKind: "Held",
    });
    localRepo.setSlotState("slot-2", {
      slotId: "slot-2",
      intentStatus: "pending",
      lastKnownTxHash: null,
      lastKnownEventKind: null,
    });

    const result = await reconciler.reconcile();
    expect(result.slotsEvaluated).toBe(2);
    expect(result.slotsInSync).toBe(1);
    expect(result.driftedSlots).toHaveLength(1);
    expect(result.driftedSlots[0].slotId).toBe("slot-2");
  });
});
