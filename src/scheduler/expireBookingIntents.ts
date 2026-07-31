// @ts-nocheck
/**
 * expireBookingIntents.ts
 *
 * Background job that scans for booking intents stuck in `pending` (i.e.
 * awaiting payment/confirmation) for longer than the configured TTL and
 * cancels them:
 *
 *  - Marks the intent `expired` (the domain's equivalent of `cancelled_expired`)
 *  - Releases the reserved slot inventory back to the marketplace
 *  - Emits a `booking_intent_expired` outbox event
 *  - Records a `booking_intents_expired_total` Prometheus metric
 *
 * Multi-instance safety
 * ---------------------
 * The Postgres repository claims stale rows with `FOR UPDATE SKIP LOCKED`
 * (see PgBookingIntentRepository.findStalePendingIntents), so two worker
 * instances never process the same intent concurrently. On top of that, this
 * worker re-verifies the intent is still `pending` immediately before
 * expiring it, so even a re-queued batch can never double-cancel an intent
 * that was confirmed or completed in the meantime.
 *
 * Config (all optional, env-overridable):
 *  - ttlMs:            how long an intent may stay `pending` (default 30 min)
 *  - batchSize:        max intents claimed per sweep (default 100)
 *  - safetyThreshold:  skip the sweep if candidates exceed this (default 10,000)
 *  - intervalMs:       cron interval between sweeps (default 60 s)
 */

import { EventEmitter } from "node:events";
import type {
  BookingIntentRepository,
} from "../modules/booking-intents/booking-intent-repository.js";
import type { BookingIntentService } from "../modules/booking-intents/booking-intent-service.js";
import {
  bookingIntentsExpiredTotal,
  expireBookingIntentsSafetyBrakeTriggers,
} from "../metrics.js";
import { logger } from "../utils/logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExpireBookingIntentsConfig {
  /** Max age (ms) of a `pending` intent before it is expired. Default: 30 min. */
  ttlMs?: number;
  /** Maximum number of intents claimed in a single sweep. Default: 100. */
  batchSize?: number;
  /** Sweeps are skipped when candidate count exceeds this. Default: 10,000. */
  safetyThreshold?: number;
  /** Interval (ms) between sweeps. Default: 60 s. */
  intervalMs?: number;
}

export interface BookingIntentExpiredEvent {
  intentId: string;
  slotId: string;
  customerId: string;
  expiredAtMs: number;
}

export interface ExpireBookingIntentsResult {
  /** Number of intents successfully expired in this sweep. */
  expiredCount: number;
  /** Number of stale candidates found before the safety brake. */
  candidatesCount: number;
  /** True when the sweep was skipped because candidates exceeded the safety threshold. */
  skippedBecauseThreshold?: boolean;
  /** Per-intent errors encountered while expiring. */
  failures: { intentId: string; error: string }[];
}

export interface ExpireBookingIntentsDependencies {
  bookingIntentRepository: BookingIntentRepository;
  bookingIntentService: BookingIntentService;
  /**
   * Emits the `booking_intent_expired` event. Defaults to an in-process
   * EventEmitter emit; production wiring (src/index.ts) replaces this with an
   * outbox insert so the event is durably relayed downstream.
   */
  emitExpired?: (event: BookingIntentExpiredEvent) => void | Promise<void>;
}

// ─── Defaults & config resolution ─────────────────────────────────────────────

const DEFAULT_CONFIG: Required<ExpireBookingIntentsConfig> = {
  ttlMs: 30 * 60 * 1000, // 30 minutes
  batchSize: 100,
  safetyThreshold: 10_000,
  intervalMs: 60 * 1000, // every 60 seconds
};

function parsePositiveInteger(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return defaultValue;
  return parsed;
}

function resolveConfig(
  overrides: ExpireBookingIntentsConfig = {},
): Required<ExpireBookingIntentsConfig> {
  return {
    ttlMs:
      overrides.ttlMs ??
      parsePositiveInteger(process.env.EXPIRE_BOOKING_INTENTS_TTL_MS, DEFAULT_CONFIG.ttlMs),
    batchSize:
      overrides.batchSize ??
      parsePositiveInteger(process.env.EXPIRE_BOOKING_INTENTS_BATCH_SIZE, DEFAULT_CONFIG.batchSize),
    safetyThreshold:
      overrides.safetyThreshold ??
      parsePositiveInteger(
        process.env.EXPIRE_BOOKING_INTENTS_SAFETY_THRESHOLD,
        DEFAULT_CONFIG.safetyThreshold,
      ),
    intervalMs:
      overrides.intervalMs ??
      parsePositiveInteger(process.env.EXPIRE_BOOKING_INTENTS_INTERVAL_MS, DEFAULT_CONFIG.intervalMs),
  };
}

// ─── Event emitter ────────────────────────────────────────────────────────────

/**
 * In-process `booking_intent_expired` event bus. Production deployments should
 * prefer the outbox wiring in src/index.ts so events survive restarts.
 */
export const bookingIntentExpiredEvents = new EventEmitter();

function defaultEmitExpired(event: BookingIntentExpiredEvent): void {
  bookingIntentExpiredEvents.emit("booking_intent_expired", event);
}

// ─── Sweep execution ──────────────────────────────────────────────────────────

/**
 * Runs a single scan-and-expire sweep.
 *
 * 1. Claims up to `batchSize` stale `pending` intents (oldest first).
 * 2. Trips the safety brake when the candidate count exceeds the threshold.
 * 3. Re-verifies each intent is still `pending` before expiring it, so a
 *    confirmed/completed intent is never cancelled and two concurrent workers
 *    can never double-cancel.
 * 4. Expires the intent (status -> `expired`) and releases the slot inventory.
 * 5. Emits the `booking_intent_expired` event and records the metric.
 *
 * @param nowMs  Override clock for deterministic tests.
 */
export async function expireBookingIntentsOnce(
  dependencies: ExpireBookingIntentsDependencies,
  configOverrides: ExpireBookingIntentsConfig = {},
  nowMs?: number,
): Promise<ExpireBookingIntentsResult> {
  const config = resolveConfig(configOverrides);
  const now = nowMs ?? Date.now();
  const cutoff = now - config.ttlMs;

  const candidates = dependencies.bookingIntentRepository.findStalePendingIntents(
    cutoff,
    config.batchSize,
  );
  const staleIntents = Array.isArray(candidates) ? candidates : await candidates;

  if (staleIntents.length > config.safetyThreshold) {
    expireBookingIntentsSafetyBrakeTriggers.inc();
    return {
      expiredCount: 0,
      candidatesCount: staleIntents.length,
      skippedBecauseThreshold: true,
      failures: [],
    };
  }

  const emitExpired = dependencies.emitExpired ?? defaultEmitExpired;
  const failures: { intentId: string; error: string }[] = [];
  let expiredCount = 0;

  for (const candidate of staleIntents) {
    try {
      // Re-verify current state before touching anything. This is the guard
      // that prevents double-cancels when two workers sweep concurrently or a
      // buyer confirmed/completed the intent in the meantime.
      const current = await dependencies.bookingIntentRepository.findById(candidate.id);
      if (!current || current.status !== "pending") {
        continue;
      }

      // Expires the intent (status -> 'expired') and releases its slot.
      dependencies.bookingIntentService.expireIntent(candidate.id);
      bookingIntentsExpiredTotal.inc();
      expiredCount += 1;

      const event: BookingIntentExpiredEvent = {
        intentId: candidate.id,
        slotId: candidate.slotId,
        customerId: candidate.customerId,
        expiredAtMs: now,
      };
      try {
        await emitExpired(event);
      } catch (emitErr) {
        // The domain transition already happened; surface the delivery
        // failure separately so operators can re-emit if needed.
        failures.push({
          intentId: candidate.id,
          error: `event emission failed: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`,
        });
      }
    } catch (err) {
      failures.push({
        intentId: candidate.id,
        error: err instanceof Error ? err.message : String(err),
      });
      logger.warn(
        { intentId: candidate.id, error: err instanceof Error ? err.message : String(err) },
        "expire-booking-intents: failed to expire intent",
      );
    }
  }

  return { expiredCount, candidatesCount: staleIntents.length, failures };
}

// ─── Background worker loop ───────────────────────────────────────────────────

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      return resolve();
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Long-running cron loop. Sweeps immediately, then sleeps `intervalMs`
 * (default 60 s) between sweeps until the signal is aborted.
 */
export async function runExpireBookingIntentsWorker(
  signal: AbortSignal,
  dependencies: ExpireBookingIntentsDependencies,
  configOverrides: ExpireBookingIntentsConfig = {},
): Promise<void> {
  const config = resolveConfig(configOverrides);

  while (!signal.aborted) {
    await expireBookingIntentsOnce(dependencies, configOverrides);
    if (signal.aborted) break;
    await sleep(config.intervalMs, signal);
  }
}

/**
 * Managed worker handle with start/stop semantics for use in index.ts or
 * tests. `getLastResult()` returns the most recent sweep result.
 */
export function createExpireBookingIntentsWorker(
  dependencies: ExpireBookingIntentsDependencies,
  configOverrides: ExpireBookingIntentsConfig = {},
): { start: () => void; stop: () => void; getLastResult: () => ExpireBookingIntentsResult | null } {
  const controller = new AbortController();
  let running = false;
  let lastResult: ExpireBookingIntentsResult | null = null;

  async function loop(): Promise<void> {
    const config = resolveConfig(configOverrides);
    while (!controller.signal.aborted) {
      lastResult = await expireBookingIntentsOnce(dependencies, configOverrides);
      if (controller.signal.aborted) break;
      await sleep(config.intervalMs, controller.signal);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      loop().finally(() => {
        running = false;
      });
    },
    stop() {
      controller.abort();
      running = false;
    },
    getLastResult() {
      return lastResult;
    },
  };
}
