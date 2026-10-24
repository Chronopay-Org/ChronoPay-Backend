/**
 * subscriptionSlotGenerator.ts
 *
 * Idempotent background worker that polls for active subscriptions due for
 * slot generation and mints recurring slots using the SubscriptionService.
 *
 * Idempotency guarantees:
 * - Each subscription has a `nextSlotStartMs` cursor that is only advanced
 *   after a successful mint, so restarts and duplicate worker runs never
 *   double-create slots.
 * - Scheduling conflicts are detected via the existing SlotRepository and
 *   the cursor is advanced past the conflicting slot to avoid infinite loops.
 *
 * Design: follows the `setTimeout`-chained tick loop pattern used by other
 * schedulers in this codebase (e.g. FlagRolloutScheduler).
 */

import { SubscriptionService, type GenerateSlotsResult } from "../services/subscriptionService.js";
import { logger } from "../utils/logger.js";

export interface SubscriptionSlotGeneratorConfig {
  /** Poll interval in milliseconds (default: 60s) */
  intervalMs?: number;
  /** Maximum subscriptions to process per tick (default: 50) */
  batchSize?: number;
  /** Maximum number of ticks before auto-stopping (for testing) */
  maxRuns?: number;
}

const DEFAULT_CONFIG: Required<SubscriptionSlotGeneratorConfig> = {
  intervalMs: 60_000,
  batchSize: 50,
  maxRuns: Infinity,
};

export class SubscriptionSlotGenerator {
  private config: Required<SubscriptionSlotGeneratorConfig>;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private runCount = 0;

  constructor(
    private readonly subscriptionService: SubscriptionService,
    config: SubscriptionSlotGeneratorConfig = {},
  ) {
    this.config = {
      intervalMs: config.intervalMs ?? DEFAULT_CONFIG.intervalMs,
      batchSize: config.batchSize ?? DEFAULT_CONFIG.batchSize,
      maxRuns: config.maxRuns ?? DEFAULT_CONFIG.maxRuns,
    };
  }

  /**
   * Execute a single tick: find due subscriptions and mint slots.
   * Returns the result for testing/observability.
   */
  runOnce(): GenerateSlotsResult {
    const nowMs = Date.now();
    const result = this.subscriptionService.generateSlotsForDueSubscriptions(
      nowMs,
      this.config.batchSize,
    );

    if (result.minted.length > 0) {
      logger.info(
        {
          processed: result.processed,
          minted: result.minted.length,
          skipped: result.skipped,
          conflicts: result.conflicts.length,
        },
        "[subscription-slot-generator] tick completed",
      );
    }

    return result;
  }

  start(): void {
    if (this.timer) return;
    this.isRunning = true;

    const tick = (): void => {
      if (!this.isRunning) return;

      if (this.runCount >= this.config.maxRuns) {
        this.stop();
        return;
      }

      try {
        this.runCount++;
        this.runOnce();
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : err },
          "[subscription-slot-generator] tick failed",
        );
      }

      if (this.isRunning) {
        this.timer = setTimeout(tick, this.config.intervalMs);
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

export function createSubscriptionSlotGenerator(
  subscriptionService: SubscriptionService,
  config?: SubscriptionSlotGeneratorConfig,
): SubscriptionSlotGenerator {
  return new SubscriptionSlotGenerator(subscriptionService, config);
}
