import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  RolloutScheduleRegistry,
  getRolloutScheduleRegistry,
  resetRolloutScheduleRegistry,
} from "../rolloutScheduleRegistry.js";
import {
  RolloutScheduleError,
  ALL_TENANTS,
  type CreateRolloutScheduleInput,
  type RolloutStep,
} from "../rolloutTypes.js";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const T2 = "2026-01-03T00:00:00.000Z";
const T3 = "2026-01-04T00:00:00.000Z";

function baseInput(overrides: Partial<CreateRolloutScheduleInput> = {}): CreateRolloutScheduleInput {
  return {
    flag: "CREATE_SLOT",
    tenantId: "tenant-a",
    environment: "production",
    actor: "alice",
    steps: [
      { percentage: 10, at: T0 },
      { percentage: 50, at: T1 },
      { percentage: 100, at: T2 },
    ],
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error("expected function to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(RolloutScheduleError);
    expect((err as RolloutScheduleError).code).toBe(code);
  }
}

describe("RolloutScheduleRegistry", () => {
  let registry: RolloutScheduleRegistry;

  beforeEach(() => {
    registry = new RolloutScheduleRegistry();
  });

  // ─── create() validation ────────────────────────────────────────────────

  describe("create", () => {
    it("creates a pending schedule at 0%", () => {
      const schedule = registry.create(baseInput());

      expect(schedule.status).toBe("pending");
      expect(schedule.currentStepIndex).toBe(-1);
      expect(schedule.currentPercentage).toBe(0);
      expect(schedule.steps).toHaveLength(3);
      expect(schedule.history).toHaveLength(1);
      expect(schedule.history[0]).toMatchObject({ action: "created", percentage: 0, actor: "alice" });
    });

    it("rejects an unknown flag", () => {
      expectCode(() => registry.create(baseInput({ flag: "NOT_A_FLAG" as any })), "UNKNOWN_FLAG");
    });

    it("rejects an unknown environment", () => {
      expectCode(() => registry.create(baseInput({ environment: "staging" as any })), "UNKNOWN_ENVIRONMENT");
    });

    it("rejects a missing tenantId", () => {
      expectCode(() => registry.create(baseInput({ tenantId: "  " })), "MISSING_TENANT");
    });

    it("rejects a missing actor", () => {
      expectCode(() => registry.create(baseInput({ actor: "" })), "MISSING_ACTOR");
    });

    it("rejects an empty steps array", () => {
      expectCode(() => registry.create(baseInput({ steps: [] })), "EMPTY_STEPS");
    });

    it("rejects more than 50 steps", () => {
      const steps: RolloutStep[] = Array.from({ length: 51 }, (_, i) => ({
        percentage: i + 1,
        at: new Date(Date.parse(T0) + i * 1000).toISOString(),
      }));
      expectCode(() => registry.create(baseInput({ steps })), "TOO_MANY_STEPS");
    });

    it("rejects a non-integer or out-of-range percentage", () => {
      expectCode(
        () => registry.create(baseInput({ steps: [{ percentage: 0, at: T0 }] })),
        "INVALID_PERCENTAGE",
      );
      expectCode(
        () => registry.create(baseInput({ steps: [{ percentage: 101, at: T0 }] })),
        "INVALID_PERCENTAGE",
      );
      expectCode(
        () => registry.create(baseInput({ steps: [{ percentage: 12.5, at: T0 }] })),
        "INVALID_PERCENTAGE",
      );
    });

    it("rejects an invalid ISO timestamp", () => {
      expectCode(
        () => registry.create(baseInput({ steps: [{ percentage: 10, at: "not-a-date" }] })),
        "INVALID_TIMESTAMP",
      );
    });

    it("rejects steps that are not strictly chronological", () => {
      expectCode(
        () =>
          registry.create(
            baseInput({
              steps: [
                { percentage: 10, at: T1 },
                { percentage: 50, at: T1 },
              ],
            }),
          ),
        "STEPS_NOT_CHRONOLOGICAL",
      );
      expectCode(
        () =>
          registry.create(
            baseInput({
              steps: [
                { percentage: 10, at: T1 },
                { percentage: 50, at: T0 },
              ],
            }),
          ),
        "STEPS_NOT_CHRONOLOGICAL",
      );
    });

    it("rejects steps whose percentage does not strictly increase", () => {
      expectCode(
        () =>
          registry.create(
            baseInput({
              steps: [
                { percentage: 50, at: T0 },
                { percentage: 50, at: T1 },
              ],
            }),
          ),
        "STEPS_NOT_INCREASING",
      );
      expectCode(
        () =>
          registry.create(
            baseInput({
              steps: [
                { percentage: 50, at: T0 },
                { percentage: 10, at: T1 },
              ],
            }),
          ),
        "STEPS_NOT_INCREASING",
      );
    });

    it("rejects a duplicate in-flight schedule for the same flag/tenant/environment", () => {
      registry.create(baseInput());
      expectCode(() => registry.create(baseInput()), "SCHEDULE_IN_FLIGHT");
    });

    it("allows a new schedule once the previous one is rolled back", () => {
      const first = registry.create(baseInput());
      registry.advanceDue(new Date(T0));
      registry.rollback({ id: first.id, actor: "alice", reason: "bad ramp, rolling back" });

      const second = registry.create(baseInput());
      expect(second.id).not.toBe(first.id);
    });

    it("allows a new schedule once the previous one has completed", () => {
      const first = registry.create(baseInput());
      registry.advanceDue(new Date(T2));
      expect(registry.getById(first.id)?.status).toBe("completed");

      const second = registry.create(baseInput());
      expect(second.id).not.toBe(first.id);
    });

    it("does not block schedules for a different tenant or environment", () => {
      registry.create(baseInput());
      expect(() => registry.create(baseInput({ tenantId: "tenant-b" }))).not.toThrow();
      expect(() => registry.create(baseInput({ tenantId: "tenant-a", environment: "development" }))).not.toThrow();
    });
  });

  // ─── advanceDue() ───────────────────────────────────────────────────────

  describe("advanceDue", () => {
    it("stays pending before the first step's time", () => {
      const schedule = registry.create(baseInput());
      const advanced = registry.advanceDue(new Date(Date.parse(T0) - 1000));

      expect(advanced).toHaveLength(0);
      expect(registry.getById(schedule.id)?.status).toBe("pending");
      expect(registry.getById(schedule.id)?.currentPercentage).toBe(0);
    });

    it("advances to the first step once its time passes", () => {
      const schedule = registry.create(baseInput());
      const advanced = registry.advanceDue(new Date(T0));

      expect(advanced).toHaveLength(1);
      const updated = registry.getById(schedule.id)!;
      expect(updated.status).toBe("active");
      expect(updated.currentStepIndex).toBe(0);
      expect(updated.currentPercentage).toBe(10);
      expect(updated.history.at(-1)).toMatchObject({ action: "advanced", percentage: 10, actor: "scheduler" });
    });

    it("marks the schedule completed on the last step", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T2));
      const updated = registry.getById(schedule.id)!;

      expect(updated.status).toBe("completed");
      expect(updated.currentStepIndex).toBe(2);
      expect(updated.currentPercentage).toBe(100);
    });

    it("jumps straight to the latest due step when multiple steps are missed (outage catch-up)", () => {
      const schedule = registry.create(baseInput());

      // Simulate the scheduler being down until well past step 1 and step 2's times.
      const advanced = registry.advanceDue(new Date(Date.parse(T2) + 60_000));

      expect(advanced).toHaveLength(1); // one advance call, not three
      const updated = registry.getById(schedule.id)!;
      expect(updated.currentStepIndex).toBe(2);
      expect(updated.currentPercentage).toBe(100);
      // Only one new "advanced" history entry was appended — no replay of step 0/1.
      expect(updated.history.filter((h) => h.action === "advanced")).toHaveLength(1);
    });

    it("does not advance a paused schedule even if a step is due", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T0));
      registry.pause(schedule.id, "alice");

      const advanced = registry.advanceDue(new Date(T2));
      expect(advanced).toHaveLength(0);
      expect(registry.getById(schedule.id)?.currentPercentage).toBe(10);
    });

    it("does not advance a rolled-back schedule", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T1));
      registry.rollback({ id: schedule.id, actor: "alice", reason: "incident: reverting ramp" });

      const advanced = registry.advanceDue(new Date(T2));
      expect(advanced).toHaveLength(0);
    });

    it("defaults `now` to the current wall-clock time when omitted", () => {
      const schedule = registry.create(
        baseInput({ steps: [{ percentage: 10, at: new Date(Date.now() - 1000).toISOString() }] }),
      );
      const advanced = registry.advanceDue();
      expect(advanced).toHaveLength(1);
      expect(registry.getById(schedule.id)?.currentPercentage).toBe(10);
    });

    it("does not re-advance a completed schedule", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T2));
      const advanced = registry.advanceDue(new Date(Date.parse(T2) + 60_000));
      expect(advanced).toHaveLength(0);
      expect(registry.getById(schedule.id)?.status).toBe("completed");
    });
  });

  // ─── pause() / resume() ─────────────────────────────────────────────────

  describe("pause", () => {
    it("freezes the schedule at its current percentage", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T0));

      const paused = registry.pause(schedule.id, "alice", "investigating a bug");
      expect(paused.status).toBe("paused");
      expect(paused.currentPercentage).toBe(10);
      expect(paused.history.at(-1)).toMatchObject({ action: "paused", reason: "investigating a bug" });
    });

    it("throws NOT_FOUND for an unknown id", () => {
      expectCode(() => registry.pause("nope", "alice"), "NOT_FOUND");
    });

    it("throws MISSING_ACTOR when actor is blank", () => {
      const schedule = registry.create(baseInput());
      expectCode(() => registry.pause(schedule.id, ""), "MISSING_ACTOR");
    });

    it("throws ALREADY_PAUSED when pausing twice", () => {
      const schedule = registry.create(baseInput());
      registry.pause(schedule.id, "alice");
      expectCode(() => registry.pause(schedule.id, "alice"), "ALREADY_PAUSED");
    });

    it("throws INVALID_STATE_TRANSITION for a completed schedule", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T2));
      expectCode(() => registry.pause(schedule.id, "alice"), "INVALID_STATE_TRANSITION");
    });

    it("throws INVALID_STATE_TRANSITION for a rolled-back schedule", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T0));
      registry.rollback({ id: schedule.id, actor: "alice", reason: "reverting due to error spike" });
      expectCode(() => registry.pause(schedule.id, "alice"), "INVALID_STATE_TRANSITION");
    });
  });

  describe("resume", () => {
    it("catches up immediately to whatever step is due (step-during-outage-while-paused)", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T0)); // 10%
      registry.pause(schedule.id, "alice");

      // Steps 1 and 2's times pass while the schedule sits paused.
      const resumed = registry.resume(schedule.id, "bob", new Date(Date.parse(T2) + 60_000));

      expect(resumed.status).toBe("completed");
      expect(resumed.currentPercentage).toBe(100);
      const advancedEntries = resumed.history.filter((h) => h.action === "advanced");
      expect(advancedEntries).toHaveLength(2); // step 0 (before pause) + the catch-up jump
    });

    it("resumes to 'pending' if no step was ever reached", () => {
      const schedule = registry.create(baseInput());
      registry.pause(schedule.id, "alice");
      const resumed = registry.resume(schedule.id, "bob", new Date(Date.parse(T0) - 1000));
      expect(resumed.status).toBe("pending");
      expect(resumed.currentPercentage).toBe(0);
    });

    it("throws NOT_FOUND for an unknown id", () => {
      expectCode(() => registry.resume("nope", "alice"), "NOT_FOUND");
    });

    it("throws MISSING_ACTOR when actor is blank", () => {
      const schedule = registry.create(baseInput());
      registry.pause(schedule.id, "alice");
      expectCode(() => registry.resume(schedule.id, "  "), "MISSING_ACTOR");
    });

    it("throws INVALID_STATE_TRANSITION when the schedule is not paused", () => {
      const schedule = registry.create(baseInput());
      expectCode(() => registry.resume(schedule.id, "alice"), "INVALID_STATE_TRANSITION");
    });
  });

  // ─── rollback() ─────────────────────────────────────────────────────────

  describe("rollback", () => {
    it("defaults to one step back", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T1)); // step index 1, 50%

      const rolled = registry.rollback({ id: schedule.id, actor: "alice", reason: "error rate spiked" });
      expect(rolled.status).toBe("rolled_back");
      expect(rolled.currentStepIndex).toBe(0);
      expect(rolled.currentPercentage).toBe(10);
    });

    it("rolls back across multiple steps at once when toStepIndex is given", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T2)); // step index 2, 100%, completed

      const rolled = registry.rollback({
        id: schedule.id,
        actor: "alice",
        reason: "full revert to pre-ramp state",
        toStepIndex: -1,
      });
      expect(rolled.currentStepIndex).toBe(-1);
      expect(rolled.currentPercentage).toBe(0);
      expect(rolled.status).toBe("rolled_back");
    });

    it("is terminal — the scheduler will not advance it again even after rollback", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T1));
      registry.rollback({ id: schedule.id, actor: "alice", reason: "reverting a bad ramp" });

      const advanced = registry.advanceDue(new Date(Date.parse(T2) + 60_000));
      expect(advanced).toHaveLength(0);
      expect(registry.getById(schedule.id)?.status).toBe("rolled_back");
      expect(registry.getById(schedule.id)?.currentPercentage).toBe(10);
    });

    it("throws NOT_FOUND for an unknown id", () => {
      expectCode(
        () => registry.rollback({ id: "nope", actor: "alice", reason: "some reason" }),
        "NOT_FOUND",
      );
    });

    it("throws MISSING_ACTOR when actor is blank", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T0));
      expectCode(
        () => registry.rollback({ id: schedule.id, actor: "", reason: "some reason" }),
        "MISSING_ACTOR",
      );
    });

    it("throws MISSING_REASON when reason is blank", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T0));
      expectCode(() => registry.rollback({ id: schedule.id, actor: "alice", reason: "  " }), "MISSING_REASON");
    });

    it("throws NOTHING_TO_ROLLBACK when no step has been reached yet", () => {
      const schedule = registry.create(baseInput());
      expectCode(
        () => registry.rollback({ id: schedule.id, actor: "alice", reason: "some reason" }),
        "NOTHING_TO_ROLLBACK",
      );
    });

    it("throws ALREADY_ROLLED_BACK on a second rollback", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T1));
      registry.rollback({ id: schedule.id, actor: "alice", reason: "first rollback" });
      expectCode(
        () => registry.rollback({ id: schedule.id, actor: "alice", reason: "second rollback" }),
        "ALREADY_ROLLED_BACK",
      );
    });

    it("throws INVALID_ROLLBACK_TARGET when toStepIndex is not before the current step", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T1)); // step index 1

      expectCode(
        () =>
          registry.rollback({ id: schedule.id, actor: "alice", reason: "bad target", toStepIndex: 1 }),
        "INVALID_ROLLBACK_TARGET",
      );
      expectCode(
        () =>
          registry.rollback({ id: schedule.id, actor: "alice", reason: "bad target", toStepIndex: 2 }),
        "INVALID_ROLLBACK_TARGET",
      );
      expectCode(
        () =>
          registry.rollback({ id: schedule.id, actor: "alice", reason: "bad target", toStepIndex: -2 }),
        "INVALID_ROLLBACK_TARGET",
      );
    });
  });

  // ─── list() / getById() / findGoverningSchedule() ───────────────────────

  describe("read helpers", () => {
    it("getById returns undefined for an unknown id", () => {
      expect(registry.getById("nope")).toBeUndefined();
    });

    it("list filters by flag, tenantId, environment, and status", () => {
      registry.create(baseInput());
      registry.create(baseInput({ tenantId: "tenant-b" }));
      registry.create(baseInput({ flag: "SMS_NOTIFICATIONS", tenantId: "tenant-c" }));

      expect(registry.list({ tenantId: "tenant-a" })).toHaveLength(1);
      expect(registry.list({ flag: "SMS_NOTIFICATIONS" })).toHaveLength(1);
      expect(registry.list({ environment: "production" })).toHaveLength(3);
      expect(registry.list({ status: "pending" })).toHaveLength(3);
      expect(registry.list()).toHaveLength(3);
    });

    it("findGoverningSchedule prefers a tenant-specific schedule over the wildcard", () => {
      registry.create(baseInput({ tenantId: ALL_TENANTS, steps: [{ percentage: 5, at: T0 }] }));
      registry.create(baseInput({ tenantId: "tenant-a", steps: [{ percentage: 40, at: T0 }] }));
      registry.advanceDue(new Date(T0));

      const governing = registry.findGoverningSchedule("CREATE_SLOT", "tenant-a", "production");
      expect(governing?.currentPercentage).toBe(40);

      const otherTenant = registry.findGoverningSchedule("CREATE_SLOT", "tenant-z", "production");
      expect(otherTenant?.currentPercentage).toBe(5);
    });

    it("findGoverningSchedule returns undefined when nothing governs the tuple", () => {
      expect(registry.findGoverningSchedule("CREATE_SLOT", "tenant-a", "production")).toBeUndefined();
    });

    it("returned schedules are deep copies that cannot mutate internal state", () => {
      const schedule = registry.create(baseInput());
      schedule.steps.push({ percentage: 999, at: T3 });
      schedule.history.push({ action: "advanced", stepIndex: 5, percentage: 999, timestamp: T3, actor: "eve" });

      const fresh = registry.getById(schedule.id)!;
      expect(fresh.steps).toHaveLength(3);
      expect(fresh.history).toHaveLength(1);
    });
  });
});

describe("getRolloutScheduleRegistry singleton", () => {
  afterEach(() => {
    resetRolloutScheduleRegistry();
  });

  it("returns the same instance across calls", () => {
    expect(getRolloutScheduleRegistry()).toBe(getRolloutScheduleRegistry());
  });

  it("_reset clears schedules and identity", () => {
    const registry = getRolloutScheduleRegistry();
    registry.create(baseInput());
    expect(registry.list()).toHaveLength(1);

    resetRolloutScheduleRegistry();
    expect(getRolloutScheduleRegistry()).not.toBe(registry);
    expect(getRolloutScheduleRegistry().list()).toHaveLength(0);
  });
});
