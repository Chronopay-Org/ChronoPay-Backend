// src/scheduler/reminderAutoscaler.ts
import { ReminderAutoscaleConfig, defaultAutoscaleConfig } from "./reminderConfig.js";

export class ReminderAutoscaler {
  private config: ReminderAutoscaleConfig;
  private lastScaleUp = 0;
  private lastScaleDown = 0;
  private currentConcurrency: number;

  constructor(config?: Partial<ReminderAutoscaleConfig>) {
    this.config = { ...defaultAutoscaleConfig, ...(config ?? {}) };
    this.currentConcurrency = this.config.minConcurrency;
  }

  /** Update desired concurrency based on current backlog size. Returns the new concurrency. */
  public update(backlogSize: number): number {
    const now = Date.now();
    const perWorker = backlogSize / this.currentConcurrency;

    // Scale up if backlog per worker exceeds threshold and cooldown passed
    if (
      perWorker > this.config.scaleUpThreshold &&
      this.currentConcurrency < this.config.maxConcurrency &&
      now - this.lastScaleUp > this.config.scaleUpCooldownMs
    ) {
      this.currentConcurrency++;
      this.lastScaleUp = now;
    }
    // Scale down using hysteresis (lower threshold & longer cooldown)
    else if (
      perWorker < this.config.scaleDownThreshold &&
      this.currentConcurrency > this.config.minConcurrency &&
      now - this.lastScaleDown > this.config.scaleDownCooldownMs
    ) {
      this.currentConcurrency--;
      this.lastScaleDown = now;
    }
    return this.currentConcurrency;
  }

  public getCurrentConcurrency(): number {
    return this.currentConcurrency;
  }
}
