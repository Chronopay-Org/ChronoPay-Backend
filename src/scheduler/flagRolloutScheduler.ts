/**
 * flagRolloutScheduler.ts
 * ------------------------
 * Periodically advances scheduled feature-flag rollouts (#570) to whatever
 * step is due. Mirrors the `TierAlertScheduler` shape (see
 * tierAlertScheduler.ts): a `setTimeout`-chained tick loop with an
 * injectable registry/clock so tests never depend on real wall-clock time.
 *
 * "Missed step" / "outage" safety is handled inside
 * `RolloutScheduleRegistry.advanceDue` itself — this class just decides
 * *when* to call it.
 */

import {
  getRolloutScheduleRegistry,
  type RolloutScheduleRegistry,
} from "../flags/rolloutScheduleRegistry.js";
import type { RolloutSchedule } from "../flags/rolloutTypes.js";
import { logger } from "../utils/logger.js";


export interface FlagRolloutSchedulerOptions {
  registry?: RolloutScheduleRegistry;
  runIntervalMs?: number;
  now?: () => Date;
  onAdvance?: (advanced: RolloutSchedule[]) => void;
  maxRuns?: number;
}

const DEFAULT_INTERVAL_MS = 60 * 1000; // 1 minute — fine granularity for step timestamps

export class FlagRolloutScheduler {
  private registry: RolloutScheduleRegistry;
  private runIntervalMs: number;
  private now: () => Date;
  private onAdvance?: (advanced: RolloutSchedule[]) => void;
  private maxRuns?: number;
  private timer: NodeJS.Timeout | null = null;
  private runCount = 0;
  private isRunning = false;

  constructor(options: FlagRolloutSchedulerOptions = {}) {
    this.registry = options.registry ?? getRolloutScheduleRegistry();
    this.runIntervalMs = options.runIntervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    this.onAdvance = options.onAdvance;
    this.maxRuns = options.maxRuns;
  }

  runOnce(): RolloutSchedule[] {
    const advanced = this.registry.advanceDue(this.now());
    if (advanced.length > 0) {
      this.onAdvance?.(advanced);
    }
    return advanced;
  }

  start(): void {
    if (this.timer) return;
    this.isRunning = true;

    const tick = (): void => {
      if (!this.isRunning) return;

      if (this.maxRuns !== undefined && this.runCount >= this.maxRuns) {
        this.stop();
        return;
      }

      try {
        this.runCount++;
        this.runOnce();
      } catch (err) {
        logger.error(
          "[flag-rollout-scheduler] Advance tick failed:",
          err instanceof Error ? err.message : err,
        );
      }

      if (this.isRunning) {
        this.timer = setTimeout(tick, this.runIntervalMs);
      }
    };

    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getRunCount(): number {
    return this.runCount;
  }

  isActive(): boolean {
    return this.isRunning;
  }
}

export function createFlagRolloutScheduler(
  options?: FlagRolloutSchedulerOptions,
): FlagRolloutScheduler {
  return new FlagRolloutScheduler(options);
}
