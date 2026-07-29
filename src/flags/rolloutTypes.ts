import type { FeatureFlagName, RolloutEnvironment } from "./types.js";

export { ROLLOUT_ENVIRONMENTS, type RolloutEnvironment } from "./types.js";

/** Special tenant id meaning "every tenant not covered by a more specific schedule". */
export const ALL_TENANTS = "*";

export type RolloutStatus =
  | "pending"
  | "active"
  | "paused"
  | "rolled_back"
  | "completed";

/** A single ramp step: the schedule advances to `percentage` once `at` has passed. */
export interface RolloutStep {
  /** Cumulative rollout percentage this step advances to, an integer in [1, 100]. */
  percentage: number;
  /** ISO-8601 timestamp at which this step becomes due. */
  at: string;
}

export type RolloutHistoryAction =
  | "created"
  | "advanced"
  | "paused"
  | "resumed"
  | "rolled_back";

export interface RolloutHistoryEntry {
  action: RolloutHistoryAction;
  /** Step index reached as a result of this action; -1 means 0%/no step reached. */
  stepIndex: number;
  percentage: number;
  timestamp: string;
  actor: string;
  reason?: string;
}

export interface RolloutSchedule {
  id: string;
  flag: FeatureFlagName;
  /** Tenant this schedule governs, or `ALL_TENANTS` for a cross-tenant ramp. */
  tenantId: string;
  environment: RolloutEnvironment;
  steps: RolloutStep[];
  status: RolloutStatus;
  /** Index into `steps` most recently applied; -1 means no step has been reached yet. */
  currentStepIndex: number;
  currentPercentage: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  history: RolloutHistoryEntry[];
}

export interface CreateRolloutScheduleInput {
  flag: FeatureFlagName;
  tenantId: string;
  environment: RolloutEnvironment;
  steps: RolloutStep[];
  actor: string;
}

export interface RollbackRolloutInput {
  id: string;
  actor: string;
  reason: string;
  /** Step index to revert to; -1 means revert to 0%. Defaults to one step back. */
  toStepIndex?: number;
}

export class RolloutScheduleError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "RolloutScheduleError";
  }
}
