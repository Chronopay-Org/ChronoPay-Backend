/**
 * refundableHoldSweeper.ts
 *
 * Scans for expired refundable holds and releases slot capacity back to the
 * marketplace.
 *
 * Requirements & Context:
 *  - Releases slot inventory via SchedulingService.releaseSlot.
 *  - Emits release events on `holdReleaseEvents` EventEmitter which invalidates
 *    marketplace search caches for affected slots.
 *  - Records metric on release lag against expiry deadline.
 *  - Employs fair scheduling across tenants to avoid starvation during heavy backlogs.
 *  - Skips holds for paused tenants.
 *  - Prevents races with buyer confirmation by re-verifying hold state before release.
 *  - Incorporates safety-brake logic if backlog candidate count exceeds threshold.
 *  - Provides a background loop honoring AbortSignal for clean shutdown.
 */

import { EventEmitter } from "node:events";
import type { SchedulingService } from "../services/schedulingService.js";
import { invalidateSlotsCache } from "../cache/slotCache.js";
import { logger } from "../utils/logger.js";

import {
  refundableHoldReleaseLagSeconds,
  refundableHoldsReleasedTotal,
  refundableHoldSweeperSafetyBrakeTriggers,
} from "../metrics.js";

// ─── Domain Types & Interfaces ────────────────────────────────────────────────

export type RefundableHoldStatus = "active" | "confirmed" | "released" | "expired";

export interface RefundableHold {
  id: string;
  slotId: string;
  tenantId?: string;
  customerId: string;
  status: RefundableHoldStatus;
  createdAt: number;
  expiresAt: number;
  confirmedAt?: number;
  releasedAt?: number;
}

export interface RefundableHoldRepository {
  listAll(): RefundableHold[];
  findById(id: string): RefundableHold | undefined;
  updateStatus(id: string, status: RefundableHoldStatus, updatedAtMs?: number): RefundableHold;
  create(hold: Omit<RefundableHold, "id">): RefundableHold;
}

/** In-memory implementation of RefundableHoldRepository for tests and runtime */
export class InMemoryRefundableHoldRepository implements RefundableHoldRepository {
  private readonly holds = new Map<string, RefundableHold>();
  private sequence = 1;

  create(hold: Omit<RefundableHold, "id">): RefundableHold {
    const id = `hold-${this.sequence++}`;
    const record: RefundableHold = { id, ...hold };
    this.holds.set(id, record);
    return { ...record };
  }

  listAll(): RefundableHold[] {
    return Array.from(this.holds.values()).map((h) => ({ ...h }));
  }

  findById(id: string): RefundableHold | undefined {
    const hold = this.holds.get(id);
    return hold ? { ...hold } : undefined;
  }

  updateStatus(id: string, status: RefundableHoldStatus, updatedAtMs: number = Date.now()): RefundableHold {
    const hold = this.holds.get(id);
    if (!hold) {
      throw new Error(`RefundableHold with id "${id}" not found`);
    }
    const updated: RefundableHold = {
      ...hold,
      status,
      ...(status === "confirmed" ? { confirmedAt: updatedAtMs } : {}),
      ...(status === "released" || status === "expired" ? { releasedAt: updatedAtMs } : {}),
    };
    this.holds.set(id, updated);
    return { ...updated };
  }
}

// ─── Event Emitter & Cache Invalidation ───────────────────────────────────────

export interface HoldReleasedEvent {
  holdId: string;
  slotId: string;
  tenantId?: string;
  releasedAt: number;
}

/** Global or instance EventEmitter for hold release events */
export const holdReleaseEvents = new EventEmitter();

export async function onHoldReleasedDefaultHandler(_evt: HoldReleasedEvent): Promise<void> {
  try {
    await invalidateSlotsCache();
  } catch (err) {
    logger.warn({ err }, "[refundableHoldSweeper] Search cache invalidation error:");
  }
}

// Default listener to invalidate search cache when a hold is released
holdReleaseEvents.on("hold_released", (evt: HoldReleasedEvent) => {
  void onHoldReleasedDefaultHandler(evt);
});

// ─── Worker Configuration & Results ──────────────────────────────────────────

export interface RefundableHoldSweeperConfig {
  /** Maximum number of holds to release in a single sweep tick. Default: 100. */
  batchSize?: number;
  /** Safety threshold for maximum candidates before tripping safety brake. Default: 10,000. */
  safetyThreshold?: number;
  /** Polling interval in ms for the worker loop. Default: 5000. */
  intervalMs?: number;
  /** Maximum holds per tenant in a single batch (for fair scheduling). Default: unlimited. */
  maxPerTenantPerBatch?: number;
}

export interface RefundableHoldSweeperResult {
  releasedCount: number;
  skippedBecauseThreshold?: boolean;
  skippedBecausePaused?: number;
  candidatesCount: number;
}

const DEFAULT_CONFIG: Required<RefundableHoldSweeperConfig> = {
  batchSize: 100,
  safetyThreshold: 10_000,
  intervalMs: 5_000,
  maxPerTenantPerBatch: Number.POSITIVE_INFINITY,
};

function resolveConfig(overrides: RefundableHoldSweeperConfig = {}): Required<RefundableHoldSweeperConfig> {
  return {
    batchSize: overrides.batchSize ?? DEFAULT_CONFIG.batchSize,
    safetyThreshold: overrides.safetyThreshold ?? DEFAULT_CONFIG.safetyThreshold,
    intervalMs: overrides.intervalMs ?? DEFAULT_CONFIG.intervalMs,
    maxPerTenantPerBatch: overrides.maxPerTenantPerBatch ?? DEFAULT_CONFIG.maxPerTenantPerBatch,
  };
}

// ─── Fair Scheduling Helper ───────────────────────────────────────────────────

/**
 * Distributes candidate holds across tenants fairly using round-robin sampling,
 * capping per-tenant selection if maxPerTenantPerBatch is specified.
 */
function fairScheduleCandidates(
  candidates: RefundableHold[],
  batchSize: number,
  maxPerTenantPerBatch: number,
): RefundableHold[] {
  // Group by tenant
  const tenantBuckets = new Map<string, RefundableHold[]>();
  for (const item of candidates) {
    const tenantKey = item.tenantId ?? "__default__";
    if (!tenantBuckets.has(tenantKey)) {
      tenantBuckets.set(tenantKey, []);
    }
    tenantBuckets.get(tenantKey)!.push(item);
  }

  const selected: RefundableHold[] = [];
  const tenantCounts = new Map<string, number>();

  let progress = true;
  while (selected.length < batchSize && progress) {
    progress = false;
    for (const [tenantKey, bucket] of tenantBuckets.entries()) {
      if (selected.length >= batchSize) break;
      const count = tenantCounts.get(tenantKey) ?? 0;
      if (bucket.length > 0 && count < maxPerTenantPerBatch) {
        const item = bucket.shift()!;
        selected.push(item);
        tenantCounts.set(tenantKey, count + 1);
        progress = true;
      }
    }
  }

  return selected;
}

// ─── Sweep Execution ──────────────────────────────────────────────────────────

export interface SweeperDependencies {
  holdRepository: RefundableHoldRepository;
  schedulingService: SchedulingService;
}

/**
 * Executes a single scan-and-release sweep of expired refundable holds.
 *
 * 1. Queries all active holds expired relative to `nowMs`.
 * 2. Filters out holds belonging to paused tenants.
 * 3. Applies safety brake if total candidate count exceeds safety threshold.
 * 4. Selects a fair batch across tenants up to `batchSize`.
 * 5. Re-checks hold state to avoid races with buyer confirmations.
 * 6. Releases slot capacity back to marketplace via `schedulingService.releaseSlot`.
 * 7. Updates hold status to 'expired'.
 * 8. Emits 'hold_released' event to trigger search cache invalidation.
 * 9. Observes release lag metric (deadline vs actual release time).
 */
export async function sweepRefundableHoldExpiryOnce(
  deps: SweeperDependencies,
  configOverrides: RefundableHoldSweeperConfig = {},
  nowMs?: number,
): Promise<RefundableHoldSweeperResult> {
  const config = resolveConfig(configOverrides);
  const now = nowMs ?? Date.now();

  const allHolds = deps.holdRepository.listAll();
  
  // Identify active expired holds
  const expiredCandidates = allHolds.filter(
    (h) => h.status === "active" && h.expiresAt <= now,
  );

  let skippedBecausePaused = 0;
  const eligibleCandidates: RefundableHold[] = [];

  for (const hold of expiredCandidates) {
    if (hold.tenantId && deps.schedulingService.pausedTenants.has(hold.tenantId)) {
      skippedBecausePaused++;
    } else {
      eligibleCandidates.push(hold);
    }
  }

  // Safety threshold check
  if (eligibleCandidates.length > config.safetyThreshold) {
    refundableHoldSweeperSafetyBrakeTriggers.inc();
    return {
      releasedCount: 0,
      skippedBecauseThreshold: true,
      skippedBecausePaused,
      candidatesCount: eligibleCandidates.length,
    };
  }

  // Fair scheduling selection
  const batchToRelease = fairScheduleCandidates(
    eligibleCandidates,
    config.batchSize,
    config.maxPerTenantPerBatch,
  );

  let releasedCount = 0;

  for (const candidate of batchToRelease) {
    // Re-verify current hold status atomically to prevent race with buyer confirm/capture
    const currentHold = deps.holdRepository.findById(candidate.id);
    if (!currentHold || currentHold.status !== "active") {
      // Hold was confirmed or modified concurrently
      continue;
    }

    // Release slot capacity back to marketplace
    try {
      deps.schedulingService.releaseSlot(currentHold.slotId);
    } catch (err) {
      // Slot may already be released or missing, log and continue
      logger.warn({ err }, `[refundableHoldSweeper] Error releasing slot ${currentHold.slotId}:`);
    }

    // Mark hold status as expired
    deps.holdRepository.updateStatus(currentHold.id, "expired", now);
    releasedCount++;

    const tenantIdLabel = currentHold.tenantId ?? "default";

    // Record metrics: release lag against deadline (seconds)
    const lagSeconds = Math.max(0, (now - currentHold.expiresAt) / 1000);
    refundableHoldReleaseLagSeconds.labels(tenantIdLabel).observe(lagSeconds);
    refundableHoldsReleasedTotal.labels(tenantIdLabel).inc();

    // Emit event for search cache invalidation
    holdReleaseEvents.emit("hold_released", {
      holdId: currentHold.id,
      slotId: currentHold.slotId,
      tenantId: currentHold.tenantId,
      releasedAt: now,
    } as HoldReleasedEvent);
  }

  return {
    releasedCount,
    skippedBecausePaused,
    candidatesCount: eligibleCandidates.length,
  };
}

// ─── Background Worker Loop ───────────────────────────────────────────────────

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

export async function runRefundableHoldSweeper(
  signal: AbortSignal,
  deps: SweeperDependencies,
  configOverrides: RefundableHoldSweeperConfig = {},
): Promise<void> {
  const config = resolveConfig(configOverrides);

  while (!signal.aborted) {
    await sweepRefundableHoldExpiryOnce(deps, configOverrides);
    if (signal.aborted) {
      break;
    }
    await sleep(config.intervalMs, signal);
  }
}
