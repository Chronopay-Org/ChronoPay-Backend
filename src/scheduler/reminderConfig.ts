// src/scheduler/reminderConfig.ts
// src/scheduler/reminderConfig.ts
export interface ReminderAutoscaleConfig {
  /** Minimum number of concurrent workers */
  minConcurrency: number;
  /** Maximum number of concurrent workers */
  maxConcurrency: number;
  /** Backlog per worker that triggers a scale‑up */
  scaleUpThreshold: number;
  /** Backlog per worker that triggers a scale‑down */
  scaleDownThreshold: number;
  /** Minimum ms between two scale‑up actions */
  scaleUpCooldownMs: number;
  /** Minimum ms between two scale‑down actions */
  scaleDownCooldownMs: number;
}

export const defaultAutoscaleConfig: ReminderAutoscaleConfig = {
  minConcurrency: 1,
  maxConcurrency: 8,
  scaleUpThreshold: 20,
  scaleDownThreshold: 5,
  scaleUpCooldownMs: 30_000,
  scaleDownCooldownMs: 60_000,
};

