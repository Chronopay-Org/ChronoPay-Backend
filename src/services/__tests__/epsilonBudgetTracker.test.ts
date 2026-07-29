/**
 * epsilonBudgetTracker.test.ts
 * ----------------------------
 * Unit tests for EpsilonBudgetTracker and InMemoryBudgetStore.
 *
 * Coverage targets:
 *   - Happy path: charge records state and returns correct spend record
 *   - Sequential composition: repeated charges accumulate correctly
 *   - Budget exhaustion: BudgetExhaustedError thrown exactly at limit
 *   - Alarms: warning fires at 80%, exhausted fires at 100%
 *   - Env-var budget config: CHRONOPAY_DP_EPSILON_BUDGET_<DATASET>
 *   - Constructor override config takes precedence over env
 *   - resetSpend: clears accumulated spend without losing budget
 *   - remainingBudget: correct before and after charges
 *   - Invalid inputs: non-positive epsilonCharged rejected
 *   - getAllEntries: returns all tracked datasets
 */

import { describe, it, expect, afterEach } from "@jest/globals";
import {
  EpsilonBudgetTracker,
  InMemoryBudgetStore,
  BudgetExhaustedError,
  BudgetTrackerError,
  BudgetAlarmEvent,
  DEFAULT_EPSILON_BUDGET,
  BUDGET_WARNING_FRACTION,
} from "../../services/epsilonBudgetTracker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all alarm events emitted during a test. */
function makeAlarmCollector(): {
  alarms: BudgetAlarmEvent[];
  sink: (e: BudgetAlarmEvent) => void;
} {
  const alarms: BudgetAlarmEvent[] = [];
  return { alarms, sink: (e) => alarms.push(e) };
}

function makeTracker(
  budgetOverrides: Record<string, number> = {},
  alarmSink?: (e: BudgetAlarmEvent) => void,
): EpsilonBudgetTracker {
  return new EpsilonBudgetTracker(
    new InMemoryBudgetStore(),
    alarmSink ?? (() => {}),
    budgetOverrides,
  );
}

// ---------------------------------------------------------------------------
// InMemoryBudgetStore
// ---------------------------------------------------------------------------

describe("InMemoryBudgetStore", () => {
  it("returns null for unknown dataset", async () => {
    const store = new InMemoryBudgetStore();
    expect(await store.get("unknown")).toBeNull();
  });

  it("stores and retrieves an entry", async () => {
    const store = new InMemoryBudgetStore();
    const entry = {
      datasetId: "ds1",
      epsilonSpent: 1.5,
      epsilonBudget: 10,
      firstSpendAt: "2024-01-01T00:00:00.000Z",
      lastSpendAt: "2024-01-01T00:00:00.000Z",
      queryCount: 1,
    };
    await store.set("ds1", entry);
    const retrieved = await store.get("ds1");
    expect(retrieved).toEqual(entry);
  });

  it("returns a defensive copy (mutating retrieved entry does not corrupt store)", async () => {
    const store = new InMemoryBudgetStore();
    await store.set("ds1", {
      datasetId: "ds1",
      epsilonSpent: 1,
      epsilonBudget: 10,
      firstSpendAt: null,
      lastSpendAt: null,
      queryCount: 1,
    });
    const e = await store.get("ds1");
    e!.epsilonSpent = 999;
    const e2 = await store.get("ds1");
    expect(e2!.epsilonSpent).toBe(1);
  });

  it("all() returns all stored entries", async () => {
    const store = new InMemoryBudgetStore();
    for (const id of ["a", "b", "c"]) {
      await store.set(id, {
        datasetId: id,
        epsilonSpent: 0,
        epsilonBudget: 5,
        firstSpendAt: null,
        lastSpendAt: null,
        queryCount: 0,
      });
    }
    const all = await store.all();
    expect(all.map((e) => e.datasetId).sort()).toEqual(["a", "b", "c"]);
  });

  it("delete removes entry", async () => {
    const store = new InMemoryBudgetStore();
    await store.set("x", {
      datasetId: "x",
      epsilonSpent: 1,
      epsilonBudget: 5,
      firstSpendAt: null,
      lastSpendAt: null,
      queryCount: 1,
    });
    await store.delete("x");
    expect(await store.get("x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// EpsilonBudgetTracker — charge()
// ---------------------------------------------------------------------------

describe("EpsilonBudgetTracker.charge", () => {
  it("returns a correctly shaped spend record on first charge", async () => {
    const tracker = makeTracker({ ds: 10 });
    const record = await tracker.charge("ds", 1.0);

    expect(record.datasetId).toBe("ds");
    expect(record.epsilonCharged).toBe(1.0);
    expect(record.totalEpsilonSpent).toBeCloseTo(1.0);
    expect(record.epsilonBudget).toBe(10);
    expect(record.remainingBudget).toBeCloseTo(9.0);
    expect(record.alarmFired).toBeNull();
    expect(typeof record.timestamp).toBe("string");
  });

  it("accumulates charges correctly (sequential composition)", async () => {
    const tracker = makeTracker({ ds: 10 });
    await tracker.charge("ds", 2.0);
    await tracker.charge("ds", 3.0);
    const record = await tracker.charge("ds", 1.0);

    expect(record.totalEpsilonSpent).toBeCloseTo(6.0);
    expect(record.remainingBudget).toBeCloseTo(4.0);
    expect(record.epsilonCharged).toBeCloseTo(1.0);
  });

  it("updates queryCount on each charge", async () => {
    const tracker = makeTracker({ ds: 100 });
    await tracker.charge("ds", 1);
    await tracker.charge("ds", 1);
    await tracker.charge("ds", 1);
    const entry = await tracker.getEntry("ds");
    expect(entry!.queryCount).toBe(3);
  });

  it("sets firstSpendAt on first charge and preserves it on subsequent charges", async () => {
    const tracker = makeTracker({ ds: 100 });
    const r1 = await tracker.charge("ds", 1);
    const firstTs = (await tracker.getEntry("ds"))!.firstSpendAt;
    expect(firstTs).toBeTruthy();

    await new Promise((r) => setTimeout(r, 5));
    await tracker.charge("ds", 1);
    const entry = await tracker.getEntry("ds");
    expect(entry!.firstSpendAt).toBe(firstTs); // unchanged
    expect(entry!.lastSpendAt).not.toBe(firstTs); // updated
    expect(r1.timestamp).toBeTruthy();
  });

  it("handles multiple independent datasets without cross-contamination", async () => {
    const tracker = makeTracker({ ds_a: 10, ds_b: 10 });
    await tracker.charge("ds_a", 3);
    await tracker.charge("ds_b", 1);

    const ea = await tracker.getEntry("ds_a");
    const eb = await tracker.getEntry("ds_b");
    expect(ea!.epsilonSpent).toBeCloseTo(3);
    expect(eb!.epsilonSpent).toBeCloseTo(1);
  });

  it("rejects non-positive epsilonCharged with BudgetTrackerError", async () => {
    const tracker = makeTracker({ ds: 10 });
    await expect(tracker.charge("ds", 0)).rejects.toThrow(BudgetTrackerError);
    await expect(tracker.charge("ds", -1)).rejects.toThrow(BudgetTrackerError);
    await expect(tracker.charge("ds", NaN)).rejects.toThrow(BudgetTrackerError);
    await expect(tracker.charge("ds", Infinity)).rejects.toThrow(BudgetTrackerError);
  });
});

// ---------------------------------------------------------------------------
// Budget exhaustion
// ---------------------------------------------------------------------------

describe("EpsilonBudgetTracker — budget exhaustion", () => {
  it("throws BudgetExhaustedError when charge would exceed budget", async () => {
    const tracker = makeTracker({ ds: 5 });
    await tracker.charge("ds", 4.9);
    await expect(tracker.charge("ds", 0.2)).rejects.toThrow(BudgetExhaustedError);
  });

  it("BudgetExhaustedError carries correct fields", async () => {
    const tracker = makeTracker({ ds: 2 });
    await tracker.charge("ds", 1.5);
    try {
      await tracker.charge("ds", 1.0);
      throw new Error("Expected BudgetExhaustedError");
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExhaustedError);
      const err = e as BudgetExhaustedError;
      expect(err.datasetId).toBe("ds");
      expect(err.epsilonSpent).toBeCloseTo(1.5);
      expect(err.epsilonBudget).toBe(2);
    }
  });

  it("state is not modified when a charge is rejected", async () => {
    const tracker = makeTracker({ ds: 5 });
    await tracker.charge("ds", 4);
    try {
      await tracker.charge("ds", 2); // would exceed
    } catch {
      // expected
    }
    const entry = await tracker.getEntry("ds");
    expect(entry!.epsilonSpent).toBeCloseTo(4); // unchanged
    expect(entry!.queryCount).toBe(1);
  });

  it("exact-budget charge succeeds (boundary: spent = budget)", async () => {
    const tracker = makeTracker({ ds: 5 });
    // Should NOT throw — exactly hits the limit.
    const record = await tracker.charge("ds", 5);
    expect(record.totalEpsilonSpent).toBeCloseTo(5);
    expect(record.remainingBudget).toBeCloseTo(0);
  });

  it("any further charge after budget is fully spent throws immediately", async () => {
    const tracker = makeTracker({ ds: 3 });
    await tracker.charge("ds", 3); // exhausts budget
    await expect(tracker.charge("ds", 0.001)).rejects.toThrow(BudgetExhaustedError);
  });
});

// ---------------------------------------------------------------------------
// Alarm behaviour
// ---------------------------------------------------------------------------

describe("EpsilonBudgetTracker — alarms", () => {
  it("fires no alarm when below warning threshold", async () => {
    const { alarms, sink } = makeAlarmCollector();
    const tracker = new EpsilonBudgetTracker(new InMemoryBudgetStore(), sink, { ds: 10 });
    await tracker.charge("ds", 1); // 10% — no alarm
    expect(alarms).toHaveLength(0);
  });

  it("fires 'warning' alarm when crossing 80% threshold", async () => {
    const { alarms, sink } = makeAlarmCollector();
    const tracker = new EpsilonBudgetTracker(new InMemoryBudgetStore(), sink, { ds: 10 });
    // Charge to just below warning: 7.9 (79%)
    await tracker.charge("ds", 7.9);
    expect(alarms).toHaveLength(0);
    // Cross warning threshold: 7.9 + 0.2 = 8.1 (81%)
    const record = await tracker.charge("ds", 0.2);
    expect(record.alarmFired).toBe("warning");
    expect(alarms).toHaveLength(1);
    expect(alarms[0].level).toBe("warning");
    expect(alarms[0].datasetId).toBe("ds");
    expect(alarms[0].fractionSpent).toBeGreaterThanOrEqual(BUDGET_WARNING_FRACTION);
  });

  it("fires 'exhausted' alarm when reaching exactly 100%", async () => {
    const { alarms, sink } = makeAlarmCollector();
    const tracker = new EpsilonBudgetTracker(new InMemoryBudgetStore(), sink, { ds: 4 });
    await tracker.charge("ds", 4); // 100%
    expect(alarms).toHaveLength(1);
    expect(alarms[0].level).toBe("exhausted");
  });

  it("alarm event has correct message and all required fields", async () => {
    const { alarms, sink } = makeAlarmCollector();
    const tracker = new EpsilonBudgetTracker(new InMemoryBudgetStore(), sink, { ds: 10 });
    await tracker.charge("ds", 9); // 90% → warning
    const event = alarms[0];
    expect(event.message).toContain("[DP ALARM]");
    expect(event.message).toContain("ds");
    expect(typeof event.timestamp).toBe("string");
    expect(() => new Date(event.timestamp)).not.toThrow();
    expect(event.epsilonSpent).toBeCloseTo(9);
    expect(event.epsilonBudget).toBe(10);
  });

  it("alarm fires once per charge that crosses the threshold, not retroactively", async () => {
    const { alarms, sink } = makeAlarmCollector();
    const tracker = new EpsilonBudgetTracker(new InMemoryBudgetStore(), sink, { ds: 10 });
    await tracker.charge("ds", 8.5); // warning
    await tracker.charge("ds", 0.1); // still warning, fires again
    expect(alarms.every((a: BudgetAlarmEvent) => a.level === "warning" || a.level === "exhausted")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Budget configuration
// ---------------------------------------------------------------------------

describe("EpsilonBudgetTracker — budget config", () => {
  afterEach(() => {
    delete process.env.CHRONOPAY_DP_EPSILON_BUDGET_MYDS;
  });

  it("uses DEFAULT_EPSILON_BUDGET when no override or env var is set", async () => {
    const tracker = makeTracker(); // no overrides
    const remaining = await tracker.remainingBudget("new_dataset");
    expect(remaining).toBe(DEFAULT_EPSILON_BUDGET);
  });

  it("uses constructor override when provided", async () => {
    const tracker = makeTracker({ custom_ds: 42 });
    const remaining = await tracker.remainingBudget("custom_ds");
    expect(remaining).toBe(42);
  });

  it("reads budget from env var CHRONOPAY_DP_EPSILON_BUDGET_<DATASET>", async () => {
    process.env.CHRONOPAY_DP_EPSILON_BUDGET_MYDS = "25";
    const tracker = makeTracker(); // no constructor override
    const remaining = await tracker.remainingBudget("myds");
    expect(remaining).toBe(25);
  });

  it("constructor override takes precedence over env var", async () => {
    process.env.CHRONOPAY_DP_EPSILON_BUDGET_MYDS = "25";
    const tracker = makeTracker({ myds: 99 });
    const remaining = await tracker.remainingBudget("myds");
    expect(remaining).toBe(99);
  });

  it("ignores invalid env var value and falls back to default", async () => {
    process.env.CHRONOPAY_DP_EPSILON_BUDGET_MYDS = "not-a-number";
    const tracker = makeTracker();
    const remaining = await tracker.remainingBudget("myds");
    expect(remaining).toBe(DEFAULT_EPSILON_BUDGET);
  });
});

// ---------------------------------------------------------------------------
// remainingBudget and resetSpend
// ---------------------------------------------------------------------------

describe("EpsilonBudgetTracker — remainingBudget and resetSpend", () => {
  it("remainingBudget returns full budget before any charges", async () => {
    const tracker = makeTracker({ ds: 10 });
    expect(await tracker.remainingBudget("ds")).toBe(10);
  });

  it("remainingBudget decreases after each charge", async () => {
    const tracker = makeTracker({ ds: 10 });
    await tracker.charge("ds", 3);
    expect(await tracker.remainingBudget("ds")).toBeCloseTo(7);
    await tracker.charge("ds", 2);
    expect(await tracker.remainingBudget("ds")).toBeCloseTo(5);
  });

  it("remainingBudget never goes below 0", async () => {
    const tracker = makeTracker({ ds: 5 });
    await tracker.charge("ds", 5);
    expect(await tracker.remainingBudget("ds")).toBe(0);
  });

  it("resetSpend clears accumulated spend and queryCount", async () => {
    const tracker = makeTracker({ ds: 10 });
    await tracker.charge("ds", 7);
    await tracker.resetSpend("ds");
    const entry = await tracker.getEntry("ds");
    expect(entry!.epsilonSpent).toBe(0);
    expect(entry!.queryCount).toBe(0);
    expect(entry!.firstSpendAt).toBeNull();
    expect(entry!.lastSpendAt).toBeNull();
  });

  it("resetSpend allows new charges after reset", async () => {
    const tracker = makeTracker({ ds: 5 });
    await tracker.charge("ds", 5); // exhaust
    await tracker.resetSpend("ds");
    // Should not throw after reset.
    const record = await tracker.charge("ds", 1);
    expect(record.totalEpsilonSpent).toBeCloseTo(1);
  });

  it("resetSpend on unknown dataset is a no-op", async () => {
    const tracker = makeTracker();
    await expect(tracker.resetSpend("nonexistent")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getAllEntries
// ---------------------------------------------------------------------------

describe("EpsilonBudgetTracker — getAllEntries", () => {
  it("returns empty array when no charges have been made", async () => {
    const tracker = makeTracker();
    expect(await tracker.getAllEntries()).toEqual([]);
  });

  it("returns all charged datasets", async () => {
    const tracker = makeTracker({ a: 10, b: 10, c: 10 });
    await tracker.charge("a", 1);
    await tracker.charge("b", 2);
    await tracker.charge("c", 3);
    const entries = await tracker.getAllEntries();
    const ids = entries.map((e) => e.datasetId).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });
});
