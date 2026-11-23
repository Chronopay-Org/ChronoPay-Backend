/**
 * rolloutScheduleRegistry.ts
 * --------------------------
 * In-process registry for scheduled, percentage-based feature-flag rollouts
 * (#570). A rollout schedule ramps a flag's traffic percentage up through an
 * ordered list of time-based steps, scoped to a single (flag, tenant,
 * environment) tuple — mirrors the in-memory singleton + immutable-read
 * pattern used by `FraudModelRegistry` (see fraudModelRegistry.ts).
 *
 * Design constraints
 * ------------------
 * - Synchronous, single-writer, single-process. Node's single-threaded
 *   execution makes read/write pairs atomic without an explicit mutex.
 * - "Missed step" / "step during outage" safety: advancing always jumps to
 *   the *latest* due step rather than replaying every intermediate step, so
 *   a scheduler that was down (or a schedule that was paused) for a while
 *   does not fire a burst of intermediate percentages on catch-up.
 * - Rollback is terminal by design: once rolled back, the scheduler will
 *   never advance the schedule again. An operator must create a fresh
 *   schedule to resume ramping. This is deliberate — an incident-triggered
 *   rollback should never silently resume ramping up on its own.
 * - Only one "in-flight" (pending/active/paused) schedule may exist per
 *   (flag, tenant, environment) tuple at a time; a new one may be created
 *   once the previous is `completed` or `rolled_back`.
 */

import {
  FEATURE_FLAG_NAMES,
  ROLLOUT_ENVIRONMENTS,
  type FeatureFlagName,
  type RolloutEnvironment,
} from "./types.js";
import {
  ALL_TENANTS,
  RolloutScheduleError,
  type CreateRolloutScheduleInput,
  type RollbackRolloutInput,
  type RolloutHistoryAction,
  type RolloutSchedule,
  type RolloutStatus,
  type RolloutStep,
} from "./rolloutTypes.js";

const MAX_STEPS = 50;
const SCHEDULER_ACTOR = "scheduler";

export interface RolloutScheduleFilter {
  flag?: FeatureFlagName;
  tenantId?: string;
  environment?: RolloutEnvironment;
  status?: RolloutStatus;
}

function cloneSchedule(schedule: RolloutSchedule): RolloutSchedule {
  return {
    ...schedule,
    steps: schedule.steps.map((s) => ({ ...s })),
    history: schedule.history.map((h) => ({ ...h })),
  };
}

function statusForStepIndex(stepIndex: number, stepsLength: number): RolloutStatus {
  if (stepIndex < 0) return "pending";
  return stepIndex === stepsLength - 1 ? "completed" : "active";
}

/** Returns the highest step index whose `at` has passed `nowMs`, or -1. */
function computeDueStepIndex(steps: readonly RolloutStep[], nowMs: number): number {
  let due = -1;
  for (const step of steps) {
    if (Date.parse(step.at) <= nowMs) {
      due += 1;
    } else {
      break; // steps are validated to be chronologically sorted
    }
  }
  return due;
}

function validateCreateInput(input: CreateRolloutScheduleInput): void {
  if (!FEATURE_FLAG_NAMES.includes(input.flag)) {
    throw new RolloutScheduleError(`Unknown feature flag: ${input.flag}`, "UNKNOWN_FLAG");
  }
  if (!ROLLOUT_ENVIRONMENTS.includes(input.environment)) {
    throw new RolloutScheduleError(
      `Unknown environment: "${input.environment}". Supported: ${ROLLOUT_ENVIRONMENTS.join(", ")}`,
      "UNKNOWN_ENVIRONMENT",
    );
  }
  if (typeof input.tenantId !== "string" || input.tenantId.trim() === "") {
    throw new RolloutScheduleError("tenantId is required", "MISSING_TENANT");
  }
  if (typeof input.actor !== "string" || input.actor.trim() === "") {
    throw new RolloutScheduleError("actor is required", "MISSING_ACTOR");
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new RolloutScheduleError("At least one rollout step is required", "EMPTY_STEPS");
  }
  if (input.steps.length > MAX_STEPS) {
    throw new RolloutScheduleError(
      `At most ${MAX_STEPS} steps are supported (got ${input.steps.length})`,
      "TOO_MANY_STEPS",
    );
  }

  let prevTimeMs = -Infinity;
  let prevPercentage = 0;
  input.steps.forEach((step, i) => {
    if (!Number.isInteger(step.percentage) || step.percentage < 1 || step.percentage > 100) {
      throw new RolloutScheduleError(
        `Step ${i} percentage must be an integer in [1, 100] (got ${step.percentage})`,
        "INVALID_PERCENTAGE",
      );
    }
    const timeMs = Date.parse(step.at);
    if (Number.isNaN(timeMs)) {
      throw new RolloutScheduleError(
        `Step ${i} has an invalid ISO-8601 timestamp: "${step.at}"`,
        "INVALID_TIMESTAMP",
      );
    }
    if (timeMs <= prevTimeMs) {
      throw new RolloutScheduleError(
        `Step ${i} timestamp must be strictly after the previous step's timestamp`,
        "STEPS_NOT_CHRONOLOGICAL",
      );
    }
    if (step.percentage <= prevPercentage) {
      throw new RolloutScheduleError(
        `Step ${i} percentage (${step.percentage}) must be strictly greater than the previous step's (${prevPercentage})`,
        "STEPS_NOT_INCREASING",
      );
    }
    prevTimeMs = timeMs;
    prevPercentage = step.percentage;
  });
}

const IN_FLIGHT_STATUSES: readonly RolloutStatus[] = ["pending", "active", "paused"];

export class RolloutScheduleRegistry {
  private schedules = new Map<string, RolloutSchedule>();
  /** (flag, tenant, environment) -> id of the schedule currently governing it. */
  private currentByKey = new Map<string, string>();
  private nextSeq = 1;

  private key(flag: FeatureFlagName, tenantId: string, environment: RolloutEnvironment): string {
    return `${flag}::${environment}::${tenantId}`;
  }

  private requireSchedule(id: string): RolloutSchedule {
    const schedule = this.schedules.get(id);
    if (!schedule) {
      throw new RolloutScheduleError(`Rollout schedule not found: ${id}`, "NOT_FOUND");
    }
    return schedule;
  }

  private applyAdvance(schedule: RolloutSchedule, stepIndex: number, actor: string): void {
    schedule.currentStepIndex = stepIndex;
    schedule.currentPercentage = schedule.steps[stepIndex].percentage;
    schedule.status = statusForStepIndex(stepIndex, schedule.steps.length);
    schedule.updatedAt = new Date().toISOString();
    schedule.history.push({
      action: "advanced",
      stepIndex,
      percentage: schedule.currentPercentage,
      timestamp: schedule.updatedAt,
      actor,
    });
  }

  create(input: CreateRolloutScheduleInput): RolloutSchedule {
    validateCreateInput(input);

    const key = this.key(input.flag, input.tenantId, input.environment);
    const existingId = this.currentByKey.get(key);
    if (existingId) {
      const existing = this.schedules.get(existingId);
      if (existing && IN_FLIGHT_STATUSES.includes(existing.status)) {
        throw new RolloutScheduleError(
          `An in-flight rollout schedule already exists for ${input.flag}/${input.environment}/${input.tenantId} ` +
            `(id=${existingId}, status=${existing.status}); pause or roll it back before creating a new one.`,
          "SCHEDULE_IN_FLIGHT",
        );
      }
    }

    const now = new Date().toISOString();
    const id = `rollout-${this.nextSeq++}-${Math.random().toString(36).slice(2, 8)}`;
    const schedule: RolloutSchedule = {
      id,
      flag: input.flag,
      tenantId: input.tenantId.trim(),
      environment: input.environment,
      steps: input.steps.map((s) => ({ ...s })),
      status: "pending",
      currentStepIndex: -1,
      currentPercentage: 0,
      createdAt: now,
      updatedAt: now,
      createdBy: input.actor.trim(),
      history: [
        {
          action: "created" satisfies RolloutHistoryAction,
          stepIndex: -1,
          percentage: 0,
          timestamp: now,
          actor: input.actor.trim(),
        },
      ],
    };

    this.schedules.set(id, schedule);
    this.currentByKey.set(key, id);
    return cloneSchedule(schedule);
  }

  getById(id: string): RolloutSchedule | undefined {
    const schedule = this.schedules.get(id);
    return schedule ? cloneSchedule(schedule) : undefined;
  }

  list(filter: RolloutScheduleFilter = {}): RolloutSchedule[] {
    return Array.from(this.schedules.values())
      .filter(
        (s) =>
          (filter.flag === undefined || s.flag === filter.flag) &&
          (filter.tenantId === undefined || s.tenantId === filter.tenantId) &&
          (filter.environment === undefined || s.environment === filter.environment) &&
          (filter.status === undefined || s.status === filter.status),
      )
      .map(cloneSchedule);
  }

  /**
   * The schedule currently governing (flag, tenantId, environment).
   * A tenant-specific schedule takes priority over an `ALL_TENANTS` wildcard.
   */
  findGoverningSchedule(
    flag: FeatureFlagName,
    tenantId: string,
    environment: RolloutEnvironment,
  ): RolloutSchedule | undefined {
    const specificId = this.currentByKey.get(this.key(flag, tenantId, environment));
    if (specificId) {
      const schedule = this.schedules.get(specificId);
      if (schedule) return cloneSchedule(schedule);
    }

    if (tenantId !== ALL_TENANTS) {
      const wildcardId = this.currentByKey.get(this.key(flag, ALL_TENANTS, environment));
      if (wildcardId) {
        const schedule = this.schedules.get(wildcardId);
        if (schedule) return cloneSchedule(schedule);
      }
    }

    return undefined;
  }

  /**
   * Advances every non-terminal, non-paused schedule to the latest step
   * whose `at` has passed `now`. Called on every scheduler tick.
   */
  advanceDue(now: Date = new Date()): RolloutSchedule[] {
    const nowMs = now.getTime();
    const advanced: RolloutSchedule[] = [];

    for (const schedule of this.schedules.values()) {
      if (schedule.status === "paused" || schedule.status === "rolled_back" || schedule.status === "completed") {
        continue;
      }
      const dueIndex = computeDueStepIndex(schedule.steps, nowMs);
      if (dueIndex > schedule.currentStepIndex) {
        this.applyAdvance(schedule, dueIndex, SCHEDULER_ACTOR);
        advanced.push(cloneSchedule(schedule));
      }
    }

    return advanced;
  }

  pause(id: string, actor: string, reason?: string): RolloutSchedule {
    const schedule = this.requireSchedule(id);
    if (schedule.status === "rolled_back" || schedule.status === "completed") {
      throw new RolloutScheduleError(
        `Cannot pause a schedule in terminal status "${schedule.status}"`,
        "INVALID_STATE_TRANSITION",
      );
    }
    if (schedule.status === "paused") {
      throw new RolloutScheduleError("Schedule is already paused", "ALREADY_PAUSED");
    }
    if (typeof actor !== "string" || actor.trim() === "") {
      throw new RolloutScheduleError("actor is required", "MISSING_ACTOR");
    }

    schedule.status = "paused";
    schedule.updatedAt = new Date().toISOString();
    schedule.history.push({
      action: "paused",
      stepIndex: schedule.currentStepIndex,
      percentage: schedule.currentPercentage,
      timestamp: schedule.updatedAt,
      actor: actor.trim(),
      reason,
    });
    return cloneSchedule(schedule);
  }

  /**
   * Resumes a paused schedule. Immediately catches up to whatever step is
   * due at `now` instead of waiting for the next scheduler tick — a
   * schedule that missed step times while paused jumps straight to the
   * latest due step rather than replaying each one in turn.
   */
  resume(id: string, actor: string, now: Date = new Date()): RolloutSchedule {
    const schedule = this.requireSchedule(id);
    if (schedule.status !== "paused") {
      throw new RolloutScheduleError(
        `Cannot resume a schedule in status "${schedule.status}" (only "paused" schedules can be resumed)`,
        "INVALID_STATE_TRANSITION",
      );
    }
    if (typeof actor !== "string" || actor.trim() === "") {
      throw new RolloutScheduleError("actor is required", "MISSING_ACTOR");
    }

    schedule.status = statusForStepIndex(schedule.currentStepIndex, schedule.steps.length);
    schedule.updatedAt = new Date().toISOString();
    schedule.history.push({
      action: "resumed",
      stepIndex: schedule.currentStepIndex,
      percentage: schedule.currentPercentage,
      timestamp: schedule.updatedAt,
      actor: actor.trim(),
    });

    const dueIndex = computeDueStepIndex(schedule.steps, now.getTime());
    if (dueIndex > schedule.currentStepIndex) {
      this.applyAdvance(schedule, dueIndex, actor.trim());
    }

    return cloneSchedule(schedule);
  }

  /**
   * Rolls back a schedule to an earlier step (or to 0% pre-ramp state).
   * Defaults to one step back; pass `toStepIndex` to jump back across
   * multiple steps at once. Terminal: the scheduler will never advance a
   * rolled-back schedule again.
   */
  rollback(input: RollbackRolloutInput): RolloutSchedule {
    const schedule = this.requireSchedule(input.id);
    if (schedule.status === "rolled_back") {
      throw new RolloutScheduleError("Schedule has already been rolled back", "ALREADY_ROLLED_BACK");
    }
    if (typeof input.actor !== "string" || input.actor.trim() === "") {
      throw new RolloutScheduleError("actor is required", "MISSING_ACTOR");
    }
    if (typeof input.reason !== "string" || input.reason.trim() === "") {
      throw new RolloutScheduleError("A rollback reason is required", "MISSING_REASON");
    }
    if (schedule.currentStepIndex === -1) {
      throw new RolloutScheduleError(
        "Schedule has not advanced past 0% yet; there is nothing to roll back",
        "NOTHING_TO_ROLLBACK",
      );
    }

    const target = input.toStepIndex ?? schedule.currentStepIndex - 1;
    if (!Number.isInteger(target) || target < -1 || target >= schedule.currentStepIndex) {
      throw new RolloutScheduleError(
        `toStepIndex must be an integer >= -1 and less than the current step index (${schedule.currentStepIndex}); got ${target}`,
        "INVALID_ROLLBACK_TARGET",
      );
    }

    schedule.currentStepIndex = target;
    schedule.currentPercentage = target >= 0 ? schedule.steps[target].percentage : 0;
    schedule.status = "rolled_back";
    schedule.updatedAt = new Date().toISOString();
    schedule.history.push({
      action: "rolled_back",
      stepIndex: target,
      percentage: schedule.currentPercentage,
      timestamp: schedule.updatedAt,
      actor: input.actor.trim(),
      reason: input.reason.trim(),
    });

    return cloneSchedule(schedule);
  }

  /** Test-isolation only — never call in production code. */
  _reset(): void {
    this.schedules.clear();
    this.currentByKey.clear();
    this.nextSeq = 1;
  }
}

let _singleton: RolloutScheduleRegistry | null = null;

export function getRolloutScheduleRegistry(): RolloutScheduleRegistry {
  if (!_singleton) _singleton = new RolloutScheduleRegistry();
  return _singleton;
}

/** Test-isolation only. */
export function resetRolloutScheduleRegistry(): void {
  if (_singleton) _singleton._reset();
  _singleton = null;
}
