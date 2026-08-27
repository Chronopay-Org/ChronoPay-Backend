import {
  BookingIntentService,
  AutoRefundResult,
} from "../modules/booking-intents/booking-intent-service.js";
import type { BookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";

export interface HoldAutoRefundWorkerConfig {
  intervalMs?: number;
  batchSize?: number;
  safetyThreshold?: number;
}

export interface HoldAutoRefundResult {
  refundedCount: number;
  totalRefundedAmountCents: number;
  failedCount: number;
  failures: AutoRefundResult[];
  skippedBecauseThreshold?: boolean;
}

const DEFAULT_CONFIG: Required<HoldAutoRefundWorkerConfig> = {
  intervalMs: 60 * 1000,
  batchSize: 100,
  safetyThreshold: 1000,
};

function parsePositiveInteger(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return defaultValue;
  return parsed;
}

function resolveConfig(
  overrides: HoldAutoRefundWorkerConfig = {},
): Required<HoldAutoRefundWorkerConfig> {
  return {
    intervalMs:
      overrides.intervalMs ??
      parsePositiveInteger(process.env.HOLD_AUTO_REFUND_INTERVAL_MS, DEFAULT_CONFIG.intervalMs),
    batchSize:
      overrides.batchSize ??
      parsePositiveInteger(process.env.HOLD_AUTO_REFUND_BATCH_SIZE, DEFAULT_CONFIG.batchSize),
    safetyThreshold:
      overrides.safetyThreshold ??
      parsePositiveInteger(
        process.env.HOLD_AUTO_REFUND_SAFETY_THRESHOLD,
        DEFAULT_CONFIG.safetyThreshold,
      ),
  };
}

interface HoldAutoRefundDependencies {
  bookingIntentService: BookingIntentService;
  bookingIntentRepository: BookingIntentRepository;
}

export function processHoldAutoRefundOnce(
  dependencies: HoldAutoRefundDependencies,
  configOverrides: HoldAutoRefundWorkerConfig = {},
  nowMs?: number,
): HoldAutoRefundResult {
  const config = resolveConfig(configOverrides);
  const effectiveNow = nowMs ?? Date.now();

  const expiredHolds = dependencies.bookingIntentRepository.findExpiredHolds(effectiveNow) as any[];

  if (expiredHolds.length > config.safetyThreshold) {
    return {
      refundedCount: 0,
      totalRefundedAmountCents: 0,
      failedCount: 0,
      failures: [],
      skippedBecauseThreshold: true,
    };
  }

  const batch = (expiredHolds as any[]).slice(0, config.batchSize);
  const results: AutoRefundResult[] = [];

  for (const hold of batch) {
    try {
      const refunded = dependencies.bookingIntentService.autoRefundHold(hold.id);
      results.push({
        intentId: refunded.id,
        success: true,
        refundedAmountCents: refunded.refundMetadata?.refundedAmountCents ?? 0,
      });
    } catch (err) {
      results.push({
        intentId: hold.id,
        success: false,
        refundedAmountCents: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const successes = results.filter((r) => r.success);
  const failures = results.filter((r) => !r.success);

  return {
    refundedCount: successes.length,
    totalRefundedAmountCents: successes.reduce((sum, r) => sum + r.refundedAmountCents, 0),
    failedCount: failures.length,
    failures,
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();

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

export async function runHoldAutoRefundWorker(
  signal: AbortSignal,
  dependencies: HoldAutoRefundDependencies,
  configOverrides: HoldAutoRefundWorkerConfig = {},
): Promise<void> {
  const config = resolveConfig(configOverrides);

  while (!signal.aborted) {
    processHoldAutoRefundOnce(dependencies, configOverrides);
    if (signal.aborted) break;
    await sleep(config.intervalMs, signal);
  }
}

export function createHoldAutoRefundWorker(
  dependencies: HoldAutoRefundDependencies,
  configOverrides: HoldAutoRefundWorkerConfig = {},
): { start: () => void; stop: () => void; getLastResult: () => HoldAutoRefundResult | null } {
  const controller = new AbortController();
  let running = false;
  let lastResult: HoldAutoRefundResult | null = null;

  return {
    start() {
      if (running) return;
      running = true;
      runHoldAutoRefundWorker(controller.signal, dependencies, configOverrides).finally(() => {
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
