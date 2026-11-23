import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  ALL_TENANTS,
  ROLLOUT_STATUSES,
  ROLLOUT_HISTORY_ACTIONS,
  ROLLOUT_ENVIRONMENTS,
  RolloutScheduleError,
  isRolloutStatus,
  isValidRolloutStep,
  isRolloutHistoryAction,
  type RolloutStatus,
  type RolloutStep,
  type RolloutHistoryAction,
  type CreateRolloutScheduleInput,
} from "../rolloutTypes.js";
import {
  RolloutScheduleRegistry,
  resetRolloutScheduleRegistry,
} from "../rolloutScheduleRegistry.js";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const T2 = "2026-01-03T00:00:00.000Z";
const T3 = "2026-01-04T00:00:00.000Z";

function baseInput(
  overrides: Partial<CreateRolloutScheduleInput> = {},
): CreateRolloutScheduleInput {
  return {
    flag: "CREATE_SLOT",
    tenantId: "tenant-a",
    environment: "production",
    actor: "tester",
    steps: [
      { percentage: 10, at: T1 },
      { percentage: 50, at: T2 },
      { percentage: 100, at: T3 },
    ],
    ...overrides,
  };
}

describe("src/flags/rolloutTypes.ts", () => {
  let registry: RolloutScheduleRegistry;

  beforeEach(() => {
    resetRolloutScheduleRegistry();
    registry = new RolloutScheduleRegistry();
  });

  // =========================================================================
  // 1. ALL_TENANTS contract & behavioral semantics
  // =========================================================================
  describe("ALL_TENANTS", () => {
    it("exposes ALL_TENANTS as a deterministic constant with value '*'", () => {
      expect(ALL_TENANTS).toBe("*");
      expect(typeof ALL_TENANTS).toBe("string");
      expect(ALL_TENANTS.length).toBe(1);
    });

    it("allows creating a schedule targeting ALL_TENANTS wildcard", () => {
      const schedule = registry.create(baseInput({ tenantId: ALL_TENANTS }));
      expect(schedule.tenantId).toBe(ALL_TENANTS);
      expect(schedule.status).toBe("pending");
    });

    it("gives priority to specific tenant schedules over ALL_TENANTS wildcard", () => {
      registry.create(
        baseInput({
          tenantId: ALL_TENANTS,
          steps: [{ percentage: 20, at: T1 }],
        }),
      );
      registry.create(
        baseInput({
          tenantId: "tenant-specific",
          steps: [{ percentage: 80, at: T1 }],
        }),
      );

      const specificGov = registry.findGoverningSchedule(
        "CREATE_SLOT",
        "tenant-specific",
        "production",
      );
      expect(specificGov).toBeDefined();
      expect(specificGov?.tenantId).toBe("tenant-specific");

      const otherGov = registry.findGoverningSchedule("CREATE_SLOT", "tenant-other", "production");
      expect(otherGov).toBeDefined();
      expect(otherGov?.tenantId).toBe(ALL_TENANTS);

      const wildcardGov = registry.findGoverningSchedule("CREATE_SLOT", ALL_TENANTS, "production");
      expect(wildcardGov).toBeDefined();
      expect(wildcardGov?.tenantId).toBe(ALL_TENANTS);
    });

    it("rejects empty or whitespace tenantId when attempting to define a schedule", () => {
      expect(() => {
        registry.create(baseInput({ tenantId: "" }));
      }).toThrow(RolloutScheduleError);

      try {
        registry.create(baseInput({ tenantId: "" }));
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("MISSING_TENANT");
      }

      expect(() => {
        registry.create(baseInput({ tenantId: "   " }));
      }).toThrow(RolloutScheduleError);

      try {
        registry.create(baseInput({ tenantId: "   " }));
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("MISSING_TENANT");
      }
    });

    it("distinguishes ALL_TENANTS from literal strings like 'all', 'default', or other wildcards", () => {
      expect(ALL_TENANTS).not.toBe("all");
      expect(ALL_TENANTS).not.toBe("default");
      expect(ALL_TENANTS).not.toBe("*.*");
    });
  });

  // =========================================================================
  // 2. RolloutStatus contract & validation
  // =========================================================================
  describe("RolloutStatus", () => {
    it("exposes ROLLOUT_STATUSES containing all five canonical states", () => {
      const expectedStatuses: RolloutStatus[] = [
        "pending",
        "active",
        "paused",
        "rolled_back",
        "completed",
      ];
      expect(ROLLOUT_STATUSES).toEqual(expectedStatuses);
      expect(ROLLOUT_STATUSES).toHaveLength(5);
    });

    it("validates recognized statuses with isRolloutStatus", () => {
      for (const status of ROLLOUT_STATUSES) {
        expect(isRolloutStatus(status)).toBe(true);
      }
    });

    it("rejects invalid status strings with isRolloutStatus", () => {
      const invalidStrings = [
        "",
        "   ",
        "Pending",
        "ACTIVE",
        "PAUSED",
        "in_progress",
        "in-flight",
        "cancelled",
        "canceled",
        "archived",
        "deleted",
        "unknown",
        "failed",
      ];
      for (const invalid of invalidStrings) {
        expect(isRolloutStatus(invalid)).toBe(false);
      }
    });

    it("rejects non-string inputs with isRolloutStatus", () => {
      const nonStrings = [null, undefined, 0, 1, -1, true, false, {}, [], Symbol("active"), NaN];
      for (const input of nonStrings) {
        expect(isRolloutStatus(input)).toBe(false);
      }
    });
  });

  // =========================================================================
  // 3. RolloutStep contract & input validation
  // =========================================================================
  describe("RolloutStep validation", () => {
    it("accepts valid RolloutStep structures with isValidRolloutStep", () => {
      const validSteps: RolloutStep[] = [
        { percentage: 1, at: T0 },
        { percentage: 25, at: "2026-06-01T12:00:00Z" },
        { percentage: 50, at: "2026-07-01T08:30:00.000Z" },
        { percentage: 99, at: "2026-08-01T23:59:59.999Z" },
        { percentage: 100, at: "2026-12-31T00:00:00+00:00" },
      ];

      for (const step of validSteps) {
        expect(isValidRolloutStep(step)).toBe(true);
      }
    });

    it("rejects out-of-bounds percentages with isValidRolloutStep and registry.create", () => {
      const invalidPercentages = [0, -1, -50, 101, 200];
      for (const pct of invalidPercentages) {
        const step = { percentage: pct, at: T1 };
        expect(isValidRolloutStep(step)).toBe(false);

        expect(() => {
          registry.create(baseInput({ steps: [step as RolloutStep] }));
        }).toThrow(RolloutScheduleError);

        try {
          registry.create(baseInput({ steps: [step as RolloutStep] }));
        } catch (err) {
          expect((err as RolloutScheduleError).code).toBe("INVALID_PERCENTAGE");
        }
      }
    });

    it("rejects non-integer percentages with isValidRolloutStep and registry.create", () => {
      const nonIntegers = [0.5, 1.5, 49.99, 99.1, NaN, Infinity, -Infinity];
      for (const pct of nonIntegers) {
        const step = { percentage: pct, at: T1 };
        expect(isValidRolloutStep(step)).toBe(false);

        expect(() => {
          registry.create(baseInput({ steps: [step as RolloutStep] }));
        }).toThrow(RolloutScheduleError);

        try {
          registry.create(baseInput({ steps: [step as RolloutStep] }));
        } catch (err) {
          expect((err as RolloutScheduleError).code).toBe("INVALID_PERCENTAGE");
        }
      }
    });

    it("rejects non-numeric percentage types with isValidRolloutStep and registry.create", () => {
      const nonNumeric = ["50", null, undefined, true, {}, []];
      for (const val of nonNumeric) {
        const step = { percentage: val as unknown as number, at: T1 };
        expect(isValidRolloutStep(step)).toBe(false);

        expect(() => {
          registry.create(baseInput({ steps: [step as RolloutStep] }));
        }).toThrow(RolloutScheduleError);

        try {
          registry.create(baseInput({ steps: [step as RolloutStep] }));
        } catch (err) {
          expect((err as RolloutScheduleError).code).toBe("INVALID_PERCENTAGE");
        }
      }
    });

    it("rejects invalid timestamps with isValidRolloutStep and registry.create", () => {
      const invalidTimestamps = ["", "not-an-iso-timestamp", "2026-13-45", "yesterday", "invalid"];

      for (const at of invalidTimestamps) {
        const step = { percentage: 50, at };
        expect(isValidRolloutStep(step)).toBe(false);

        expect(() => {
          registry.create(baseInput({ steps: [step as RolloutStep] }));
        }).toThrow(RolloutScheduleError);

        try {
          registry.create(baseInput({ steps: [step as RolloutStep] }));
        } catch (err) {
          expect((err as RolloutScheduleError).code).toBe("INVALID_TIMESTAMP");
        }
      }
    });

    it("rejects malformed step objects with isValidRolloutStep", () => {
      expect(isValidRolloutStep(null)).toBe(false);
      expect(isValidRolloutStep(undefined)).toBe(false);
      expect(isValidRolloutStep("step")).toBe(false);
      expect(isValidRolloutStep(123)).toBe(false);
      expect(isValidRolloutStep({})).toBe(false);
      expect(isValidRolloutStep({ percentage: 50 })).toBe(false);
      expect(isValidRolloutStep({ at: T1 })).toBe(false);
    });

    it("rejects empty steps array on creation", () => {
      expect(() => {
        registry.create(baseInput({ steps: [] }));
      }).toThrow(RolloutScheduleError);

      try {
        registry.create(baseInput({ steps: [] }));
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("EMPTY_STEPS");
      }
    });

    it("rejects non-array steps on creation", () => {
      expect(() => {
        registry.create(baseInput({ steps: "not-an-array" as unknown as RolloutStep[] }));
      }).toThrow(RolloutScheduleError);

      try {
        registry.create(baseInput({ steps: "not-an-array" as unknown as RolloutStep[] }));
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("EMPTY_STEPS");
      }
    });

    it("rejects non-chronological timestamps in sequence", () => {
      const nonChronologicalSteps: RolloutStep[] = [
        { percentage: 20, at: T2 },
        { percentage: 50, at: T1 },
      ];
      expect(() => {
        registry.create(baseInput({ steps: nonChronologicalSteps }));
      }).toThrow(RolloutScheduleError);

      try {
        registry.create(baseInput({ steps: nonChronologicalSteps }));
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("STEPS_NOT_CHRONOLOGICAL");
      }

      const identicalTimestamps: RolloutStep[] = [
        { percentage: 20, at: T1 },
        { percentage: 50, at: T1 },
      ];
      try {
        registry.create(baseInput({ steps: identicalTimestamps }));
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("STEPS_NOT_CHRONOLOGICAL");
      }
    });

    it("rejects non-strictly-increasing percentages in sequence", () => {
      const nonIncreasingSteps: RolloutStep[] = [
        { percentage: 50, at: T1 },
        { percentage: 50, at: T2 },
      ];
      expect(() => {
        registry.create(baseInput({ steps: nonIncreasingSteps }));
      }).toThrow(RolloutScheduleError);

      try {
        registry.create(baseInput({ steps: nonIncreasingSteps }));
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("STEPS_NOT_INCREASING");
      }

      const decreasingSteps: RolloutStep[] = [
        { percentage: 60, at: T1 },
        { percentage: 30, at: T2 },
      ];
      try {
        registry.create(baseInput({ steps: decreasingSteps }));
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("STEPS_NOT_INCREASING");
      }
    });

    it("rejects schedule definitions exceeding the 50 step maximum", () => {
      const tooManySteps: RolloutStep[] = Array.from({ length: 51 }, (_, i) => ({
        percentage: 1 + Math.floor(i * 1.5),
        at: new Date(Date.parse(T0) + (i + 1) * 60_000).toISOString(),
      }));
      for (let i = 1; i < tooManySteps.length; i++) {
        if (tooManySteps[i].percentage <= tooManySteps[i - 1].percentage) {
          tooManySteps[i].percentage = tooManySteps[i - 1].percentage + 1;
        }
      }

      expect(() => {
        registry.create(baseInput({ steps: tooManySteps }));
      }).toThrow(RolloutScheduleError);

      try {
        registry.create(baseInput({ steps: tooManySteps }));
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("TOO_MANY_STEPS");
      }
    });
  });

  // =========================================================================
  // 4. Primary state transitions & lifecycle semantics
  // =========================================================================
  describe("Primary state transitions", () => {
    it("initializes a newly created schedule in 'pending' status at 0% / stepIndex -1", () => {
      const schedule = registry.create(baseInput());
      expect(schedule.status).toBe("pending");
      expect(schedule.currentStepIndex).toBe(-1);
      expect(schedule.currentPercentage).toBe(0);
      expect(schedule.history).toHaveLength(1);
      expect(schedule.history[0].action).toBe("created");
      expect(schedule.history[0].stepIndex).toBe(-1);
      expect(schedule.history[0].percentage).toBe(0);
    });

    it("transitions pending -> active when advancing to an intermediate step", () => {
      const schedule = registry.create(baseInput());
      expect(schedule.status).toBe("pending");

      const advanced = registry.advanceDue(new Date(T1));
      expect(advanced).toHaveLength(1);
      expect(advanced[0].id).toBe(schedule.id);
      expect(advanced[0].status).toBe("active");
      expect(advanced[0].currentStepIndex).toBe(0);
      expect(advanced[0].currentPercentage).toBe(10);

      const latest = registry.getById(schedule.id);
      expect(latest?.status).toBe("active");
      expect(latest?.history).toHaveLength(2);
      expect(latest?.history[1].action).toBe("advanced");
      expect(latest?.history[1].stepIndex).toBe(0);
      expect(latest?.history[1].percentage).toBe(10);
    });

    it("transitions pending -> completed when advancing directly to the final step", () => {
      const schedule = registry.create(
        baseInput({
          steps: [{ percentage: 100, at: T1 }],
        }),
      );
      expect(schedule.status).toBe("pending");

      const advanced = registry.advanceDue(new Date(T1));
      expect(advanced).toHaveLength(1);
      expect(advanced[0].status).toBe("completed");
      expect(advanced[0].currentStepIndex).toBe(0);
      expect(advanced[0].currentPercentage).toBe(100);

      const latest = registry.getById(schedule.id);
      expect(latest?.status).toBe("completed");
      expect(latest?.history[1].action).toBe("advanced");
    });

    it("transitions active -> completed when advancing to the final step", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T1));
      expect(registry.getById(schedule.id)?.status).toBe("active");

      registry.advanceDue(new Date(T3));
      const latest = registry.getById(schedule.id);
      expect(latest?.status).toBe("completed");
      expect(latest?.currentStepIndex).toBe(2);
      expect(latest?.currentPercentage).toBe(100);
      expect(latest?.history[latest.history.length - 1].action).toBe("advanced");
    });

    it("transitions pending -> paused before any step is reached", () => {
      const schedule = registry.create(baseInput());
      const paused = registry.pause(schedule.id, "operator-1", "pause before ramp");

      expect(paused.status).toBe("paused");
      expect(paused.currentStepIndex).toBe(-1);
      expect(paused.currentPercentage).toBe(0);

      const lastHistory = paused.history[paused.history.length - 1];
      expect(lastHistory.action).toBe("paused");
      expect(lastHistory.actor).toBe("operator-1");
      expect(lastHistory.reason).toBe("pause before ramp");
    });

    it("transitions active -> paused while ramp is in progress", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T1));
      expect(registry.getById(schedule.id)?.status).toBe("active");

      const paused = registry.pause(schedule.id, "operator-1", "incident ongoing");
      expect(paused.status).toBe("paused");
      expect(paused.currentStepIndex).toBe(0);
      expect(paused.currentPercentage).toBe(10);
      expect(paused.history[paused.history.length - 1].action).toBe("paused");
    });

    it("transitions paused -> pending when resumed before any steps are due", () => {
      const schedule = registry.create(baseInput());
      registry.pause(schedule.id, "operator-1");
      expect(registry.getById(schedule.id)?.status).toBe("paused");

      const resumed = registry.resume(schedule.id, "operator-2", new Date(T0));
      expect(resumed.status).toBe("pending");
      expect(resumed.currentStepIndex).toBe(-1);
      expect(resumed.currentPercentage).toBe(0);
      expect(resumed.history[resumed.history.length - 1].action).toBe("resumed");
    });

    it("transitions paused -> active when resumed with an intermediate step due", () => {
      const schedule = registry.create(baseInput());
      registry.pause(schedule.id, "operator-1");

      const resumed = registry.resume(schedule.id, "operator-2", new Date(T2));
      expect(resumed.status).toBe("active");
      expect(resumed.currentStepIndex).toBe(1);
      expect(resumed.currentPercentage).toBe(50);

      const history = resumed.history;
      expect(history[history.length - 2].action).toBe("resumed");
      expect(history[history.length - 1].action).toBe("advanced");
      expect(history[history.length - 1].stepIndex).toBe(1);
    });

    it("transitions paused -> completed when resumed after all steps have passed", () => {
      const schedule = registry.create(baseInput());
      registry.pause(schedule.id, "operator-1");

      const resumed = registry.resume(schedule.id, "operator-2", new Date(T3));
      expect(resumed.status).toBe("completed");
      expect(resumed.currentStepIndex).toBe(2);
      expect(resumed.currentPercentage).toBe(100);
    });

    it("transitions active -> rolled_back to an earlier step", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T2));
      expect(registry.getById(schedule.id)?.currentStepIndex).toBe(1);

      const rolledBack = registry.rollback({
        id: schedule.id,
        actor: "oncall",
        reason: "latency regression",
        toStepIndex: 0,
      });

      expect(rolledBack.status).toBe("rolled_back");
      expect(rolledBack.currentStepIndex).toBe(0);
      expect(rolledBack.currentPercentage).toBe(10);
      const lastHistory = rolledBack.history[rolledBack.history.length - 1];
      expect(lastHistory.action).toBe("rolled_back");
      expect(lastHistory.reason).toBe("latency regression");
      expect(lastHistory.actor).toBe("oncall");
    });

    it("transitions active -> rolled_back to 0% (stepIndex -1)", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T1));

      const rolledBack = registry.rollback({
        id: schedule.id,
        actor: "oncall",
        reason: "critical issue",
        toStepIndex: -1,
      });

      expect(rolledBack.status).toBe("rolled_back");
      expect(rolledBack.currentStepIndex).toBe(-1);
      expect(rolledBack.currentPercentage).toBe(0);
    });

    it("transitions completed -> rolled_back", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T3));
      expect(registry.getById(schedule.id)?.status).toBe("completed");

      const rolledBack = registry.rollback({
        id: schedule.id,
        actor: "oncall",
        reason: "bug found post-rollout",
      });

      expect(rolledBack.status).toBe("rolled_back");
      expect(rolledBack.currentStepIndex).toBe(1);
      expect(rolledBack.currentPercentage).toBe(50);
    });

    it("transitions paused -> rolled_back when schedule had advanced before pausing", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T1));
      registry.pause(schedule.id, "operator");

      const rolledBack = registry.rollback({
        id: schedule.id,
        actor: "oncall",
        reason: "abort paused rollout",
        toStepIndex: -1,
      });

      expect(rolledBack.status).toBe("rolled_back");
      expect(rolledBack.currentStepIndex).toBe(-1);
      expect(rolledBack.currentPercentage).toBe(0);
    });
  });

  // =========================================================================
  // 5. Invalid / Disallowed state transitions & terminal constraints
  // =========================================================================
  describe("Invalid state transitions and terminal rules", () => {
    it("rejects pause() on a completed schedule (INVALID_STATE_TRANSITION)", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T3));
      expect(registry.getById(schedule.id)?.status).toBe("completed");

      expect(() => {
        registry.pause(schedule.id, "operator");
      }).toThrow(RolloutScheduleError);

      try {
        registry.pause(schedule.id, "operator");
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("INVALID_STATE_TRANSITION");
      }
    });

    it("rejects pause() on a rolled_back schedule (INVALID_STATE_TRANSITION)", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T1));
      registry.rollback({ id: schedule.id, actor: "operator", reason: "error" });
      expect(registry.getById(schedule.id)?.status).toBe("rolled_back");

      expect(() => {
        registry.pause(schedule.id, "operator");
      }).toThrow(RolloutScheduleError);

      try {
        registry.pause(schedule.id, "operator");
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("INVALID_STATE_TRANSITION");
      }
    });

    it("rejects pause() when already paused (ALREADY_PAUSED)", () => {
      const schedule = registry.create(baseInput());
      registry.pause(schedule.id, "operator");

      expect(() => {
        registry.pause(schedule.id, "operator");
      }).toThrow(RolloutScheduleError);

      try {
        registry.pause(schedule.id, "operator");
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("ALREADY_PAUSED");
      }
    });

    it("rejects resume() on pending, active, completed, and rolled_back schedules (INVALID_STATE_TRANSITION)", () => {
      const schedule = registry.create(baseInput());
      // pending
      expect(() => registry.resume(schedule.id, "operator")).toThrow(RolloutScheduleError);
      try {
        registry.resume(schedule.id, "operator");
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("INVALID_STATE_TRANSITION");
      }

      // active
      registry.advanceDue(new Date(T1));
      expect(() => registry.resume(schedule.id, "operator")).toThrow(RolloutScheduleError);
      try {
        registry.resume(schedule.id, "operator");
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("INVALID_STATE_TRANSITION");
      }

      // completed
      registry.advanceDue(new Date(T3));
      expect(() => registry.resume(schedule.id, "operator")).toThrow(RolloutScheduleError);
      try {
        registry.resume(schedule.id, "operator");
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("INVALID_STATE_TRANSITION");
      }

      // rolled_back
      registry.rollback({ id: schedule.id, actor: "operator", reason: "revert" });
      expect(() => registry.resume(schedule.id, "operator")).toThrow(RolloutScheduleError);
      try {
        registry.resume(schedule.id, "operator");
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("INVALID_STATE_TRANSITION");
      }
    });

    it("rejects rollback() when schedule is still at stepIndex -1 (NOTHING_TO_ROLLBACK)", () => {
      const schedule = registry.create(baseInput());
      expect(schedule.currentStepIndex).toBe(-1);

      expect(() => {
        registry.rollback({ id: schedule.id, actor: "operator", reason: "too early" });
      }).toThrow(RolloutScheduleError);

      try {
        registry.rollback({ id: schedule.id, actor: "operator", reason: "too early" });
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("NOTHING_TO_ROLLBACK");
      }
    });

    it("rejects rollback() when schedule is already rolled back (ALREADY_ROLLED_BACK)", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T1));
      registry.rollback({ id: schedule.id, actor: "operator", reason: "revert 1" });

      expect(() => {
        registry.rollback({ id: schedule.id, actor: "operator", reason: "revert 2" });
      }).toThrow(RolloutScheduleError);

      try {
        registry.rollback({ id: schedule.id, actor: "operator", reason: "revert 2" });
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("ALREADY_ROLLED_BACK");
      }
    });

    it("rejects invalid rollback target step indices (INVALID_ROLLBACK_TARGET)", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T2)); // currentStepIndex = 1

      // target equal to current step index
      expect(() => {
        registry.rollback({ id: schedule.id, actor: "operator", reason: "noop", toStepIndex: 1 });
      }).toThrow(RolloutScheduleError);
      try {
        registry.rollback({ id: schedule.id, actor: "operator", reason: "noop", toStepIndex: 1 });
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("INVALID_ROLLBACK_TARGET");
      }

      // target greater than current step index
      expect(() => {
        registry.rollback({
          id: schedule.id,
          actor: "operator",
          reason: "forward",
          toStepIndex: 2,
        });
      }).toThrow(RolloutScheduleError);
      try {
        registry.rollback({
          id: schedule.id,
          actor: "operator",
          reason: "forward",
          toStepIndex: 2,
        });
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("INVALID_ROLLBACK_TARGET");
      }

      // target less than -1
      expect(() => {
        registry.rollback({
          id: schedule.id,
          actor: "operator",
          reason: "too low",
          toStepIndex: -2,
        });
      }).toThrow(RolloutScheduleError);
      try {
        registry.rollback({
          id: schedule.id,
          actor: "operator",
          reason: "too low",
          toStepIndex: -2,
        });
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("INVALID_ROLLBACK_TARGET");
      }

      // non-integer target
      expect(() => {
        registry.rollback({
          id: schedule.id,
          actor: "operator",
          reason: "fraction",
          toStepIndex: 0.5,
        });
      }).toThrow(RolloutScheduleError);
      try {
        registry.rollback({
          id: schedule.id,
          actor: "operator",
          reason: "fraction",
          toStepIndex: 0.5,
        });
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("INVALID_ROLLBACK_TARGET");
      }
    });

    it("never advances paused, rolled_back, or completed schedules on advanceDue() ticks", () => {
      const sPaused = registry.create(baseInput({ tenantId: "tenant-paused" }));
      registry.pause(sPaused.id, "operator");

      const sCompleted = registry.create(baseInput({ tenantId: "tenant-completed" }));
      registry.advanceDue(new Date(T3));

      const sRolledBack = registry.create(baseInput({ tenantId: "tenant-rollback" }));
      registry.advanceDue(new Date(T1));
      registry.rollback({ id: sRolledBack.id, actor: "operator", reason: "revert" });

      const advanced = registry.advanceDue(new Date(T3));
      const advancedIds = advanced.map((s) => s.id);

      expect(advancedIds).not.toContain(sPaused.id);
      expect(advancedIds).not.toContain(sCompleted.id);
      expect(advancedIds).not.toContain(sRolledBack.id);

      expect(registry.getById(sPaused.id)?.status).toBe("paused");
      expect(registry.getById(sCompleted.id)?.status).toBe("completed");
      expect(registry.getById(sRolledBack.id)?.status).toBe("rolled_back");
    });
  });

  // =========================================================================
  // 6. Representative invalid operational inputs
  // =========================================================================
  describe("Representative invalid operational inputs", () => {
    it("rejects unknown feature flag names on schedule creation", () => {
      expect(() => {
        registry.create(baseInput({ flag: "UNKNOWN_FLAG" as any }));
      }).toThrow(RolloutScheduleError);

      try {
        registry.create(baseInput({ flag: "UNKNOWN_FLAG" as any }));
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("UNKNOWN_FLAG");
      }
    });

    it("rejects unsupported environment names on schedule creation", () => {
      expect(() => {
        registry.create(baseInput({ environment: "staging" as any }));
      }).toThrow(RolloutScheduleError);

      try {
        registry.create(baseInput({ environment: "staging" as any }));
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("UNKNOWN_ENVIRONMENT");
      }
    });

    it("rejects missing or empty actor across all state mutating operations", () => {
      // create
      expect(() => registry.create(baseInput({ actor: "" }))).toThrow(RolloutScheduleError);
      try {
        registry.create(baseInput({ actor: "   " }));
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("MISSING_ACTOR");
      }

      const schedule = registry.create(baseInput());

      // pause
      expect(() => registry.pause(schedule.id, "")).toThrow(RolloutScheduleError);
      try {
        registry.pause(schedule.id, "   ");
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("MISSING_ACTOR");
      }

      registry.pause(schedule.id, "valid-actor");

      // resume
      expect(() => registry.resume(schedule.id, "")).toThrow(RolloutScheduleError);
      try {
        registry.resume(schedule.id, "   ");
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("MISSING_ACTOR");
      }

      registry.resume(schedule.id, "valid-actor", new Date(T1));

      // rollback
      expect(() => registry.rollback({ id: schedule.id, actor: "", reason: "revert" })).toThrow(
        RolloutScheduleError,
      );
      try {
        registry.rollback({ id: schedule.id, actor: "   ", reason: "revert" });
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("MISSING_ACTOR");
      }
    });

    it("rejects missing or empty reason on rollback()", () => {
      const schedule = registry.create(baseInput());
      registry.advanceDue(new Date(T1));

      expect(() => registry.rollback({ id: schedule.id, actor: "operator", reason: "" })).toThrow(
        RolloutScheduleError,
      );

      try {
        registry.rollback({ id: schedule.id, actor: "operator", reason: "   " });
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("MISSING_REASON");
      }
    });

    it("rejects creating conflicting in-flight schedule for same (flag, tenant, environment)", () => {
      registry.create(baseInput());

      expect(() => {
        registry.create(baseInput());
      }).toThrow(RolloutScheduleError);

      try {
        registry.create(baseInput());
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("SCHEDULE_IN_FLIGHT");
      }
    });

    it("throws NOT_FOUND when mutating a non-existent schedule id", () => {
      const nonExistent = "rollout-9999-missing";
      expect(() => registry.pause(nonExistent, "actor")).toThrow(RolloutScheduleError);
      try {
        registry.pause(nonExistent, "actor");
      } catch (err) {
        expect((err as RolloutScheduleError).code).toBe("NOT_FOUND");
      }

      expect(() => registry.resume(nonExistent, "actor")).toThrow(RolloutScheduleError);
      expect(() =>
        registry.rollback({ id: nonExistent, actor: "actor", reason: "revert" }),
      ).toThrow(RolloutScheduleError);
    });
  });

  // =========================================================================
  // 7. RolloutScheduleError contract
  // =========================================================================
  describe("RolloutScheduleError contract", () => {
    it("is an instance of Error and sets expected properties", () => {
      const err = new RolloutScheduleError("test message", "TEST_CODE");

      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(RolloutScheduleError);
      expect(err.name).toBe("RolloutScheduleError");
      expect(err.message).toBe("test message");
      expect(err.code).toBe("TEST_CODE");
      expect(err.stack).toBeDefined();
    });
  });

  // =========================================================================
  // 8. Re-exports & History Actions
  // =========================================================================
  describe("RolloutHistoryAction & ROLLOUT_ENVIRONMENTS", () => {
    it("exposes ROLLOUT_HISTORY_ACTIONS containing all 5 lifecycle actions", () => {
      const expectedActions: RolloutHistoryAction[] = [
        "created",
        "advanced",
        "paused",
        "resumed",
        "rolled_back",
      ];
      expect(ROLLOUT_HISTORY_ACTIONS).toEqual(expectedActions);
      expect(ROLLOUT_HISTORY_ACTIONS).toHaveLength(5);
    });

    it("validates actions with isRolloutHistoryAction", () => {
      for (const action of ROLLOUT_HISTORY_ACTIONS) {
        expect(isRolloutHistoryAction(action)).toBe(true);
      }

      expect(isRolloutHistoryAction("deleted")).toBe(false);
      expect(isRolloutHistoryAction("")).toBe(false);
      expect(isRolloutHistoryAction(null)).toBe(false);
      expect(isRolloutHistoryAction(undefined)).toBe(false);
      expect(isRolloutHistoryAction(123)).toBe(false);
    });

    it("re-exports ROLLOUT_ENVIRONMENTS including development, test, and production", () => {
      expect(ROLLOUT_ENVIRONMENTS).toEqual(["development", "test", "production"]);
    });
  });
});
