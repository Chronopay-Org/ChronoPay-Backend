/**
 * fraudModelRollback.ts
 * ---------------------
 * Dual-admin–approved hotkey endpoint backing store for fraud model rollbacks (#455).
 *
 * Responsibilities
 * ----------------
 * 1. Record every successful promotion in a promotion history list so rollback
 *    can reference the "prior champion" version.
 * 2. Implement the dual-admin approval gate (same pattern as payout replay):
 *    - Admin A calls `POST /rollback/initiate`  → creates a pending request.
 *    - Admin B calls `POST /rollback/approve`   → completes the rollback.
 *    - The request expires after ROLLBACK_TTL_MS (default 5 minutes).
 * 3. Propagation: once approved, the registry's `promote` is called
 *    synchronously which rebuilds the routing snapshot in-process.  Because
 *    the registry is a single-process in-memory singleton, all new in-flight
 *    requests immediately see the new snapshot.  The 60-second SLO is
 *    satisfied by construction — the API call itself completes in milliseconds.
 * 4. Cache: the champion pointer and prior-version map are kept in Redis
 *    (when available) so a restarted process can restore its promotion history.
 *
 * Redis key layout
 * ----------------
 *   fraud:champion          → JSON   { version, snapshotId, promotedAt }
 *   fraud:promotion_history → JSON   Array<PromotionHistoryEntry> (capped at MAX_HISTORY)
 *
 * Change-freeze integration
 * -------------------------
 * If the environment variable FRAUD_ROLLBACK_FREEZE_UNTIL is set to a Unix
 * epoch (ms), all rollback operations are blocked until that timestamp passes.
 * Set this from your change-freeze tooling before deploying.
 */

import type { RedisClient } from "../cache/redisClient.js";
import { getFraudModelRegistry, type PromotionRequest } from "./fraudModelRegistry.js";
import { defaultAuditLogger } from "./auditLogger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ROLLBACK_TTL_MS = 5 * 60 * 1000; // 5 minutes — same as payout replay
export const MAX_HISTORY = 20; // keep the last 20 promotions
const REDIS_CHAMPION_KEY = "fraud:champion";
const REDIS_HISTORY_KEY = "fraud:promotion_history";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromotionHistoryEntry {
  snapshotId: string;
  /** Full promotion request (weights + overrides) so rollback can replay it exactly. */
  request: PromotionRequest;
  promotedAt: string; // ISO timestamp
  promotedBy: string;
}

export interface PendingRollback {
  rollbackId: string;
  targetSnapshotId: string;
  targetRequest: PromotionRequest;
  initiatorId: string;
  reason: string;
  expiresAt: number; // Unix epoch ms
}

export interface RollbackResult {
  snapshotId: string;
  versions: string[];
  propagationMs: number;
}

// ---------------------------------------------------------------------------
// In-memory state (authoritative; Redis is a warm-restart cache)
// ---------------------------------------------------------------------------

let _history: PromotionHistoryEntry[] = [];
const _pendingRollbacks = new Map<string, PendingRollback>();

/** Test-isolation only. */
export function _resetRollbackState(): void {
  _history = [];
  _pendingRollbacks.clear();
}

/** Expose for tests. */
export function _getHistory(): PromotionHistoryEntry[] {
  return [..._history];
}

// ---------------------------------------------------------------------------
// History management
// ---------------------------------------------------------------------------

/**
 * Record a completed promotion so it can be referenced by rollback.
 * Must be called AFTER every successful `registry.promote(...)`.
 */
export function recordPromotion(
  entry: PromotionHistoryEntry,
  redis?: RedisClient | null,
): void {
  _history.unshift(entry); // newest-first
  if (_history.length > MAX_HISTORY) {
    _history.length = MAX_HISTORY;
  }

  if (redis) {
    // Best-effort async write — don't block the caller.
    void redis
      .set(REDIS_CHAMPION_KEY, JSON.stringify(_history[0]), "EX", 7 * 24 * 3600)
      .catch(() => {});
    void redis
      .set(REDIS_HISTORY_KEY, JSON.stringify(_history), "EX", 7 * 24 * 3600)
      .catch(() => {});
  }
}

/**
 * Warm the in-memory history from Redis after a process restart.
 * Safe to call multiple times; only updates state if the cache is non-empty.
 */
export async function warmFromRedis(redis: RedisClient): Promise<void> {
  try {
    const raw = await redis.get(REDIS_HISTORY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PromotionHistoryEntry[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        _history = parsed.slice(0, MAX_HISTORY);
      }
    }
  } catch {
    // Non-fatal: we proceed without warm history
  }
}

/**
 * Return the immediately preceding promotion entry (the one BEFORE the
 * current champion).  Returns `null` when there is no prior version to
 * roll back to.
 */
export function getPriorPromotion(): PromotionHistoryEntry | null {
  // _history[0] = current; _history[1] = prior
  return _history[1] ?? null;
}

export function getLatestPromotion(): PromotionHistoryEntry | null {
  return _history[0] ?? null;
}

// ---------------------------------------------------------------------------
// Change-freeze gate
// ---------------------------------------------------------------------------

function isChangeFrozen(): boolean {
  const until = process.env.FRAUD_ROLLBACK_FREEZE_UNTIL;
  if (!until) return false;
  const ts = Number(until);
  return Number.isFinite(ts) && Date.now() < ts;
}

// ---------------------------------------------------------------------------
// Dual-admin initiate
// ---------------------------------------------------------------------------

export interface InitiateRollbackOptions {
  initiatorId: string;
  reason: string;
  /** Override which snapshot to roll back to (defaults to the prior promotion). */
  targetSnapshotId?: string;
}

export interface InitiateRollbackResult {
  rollbackId: string;
  targetSnapshotId: string;
  expiresAt: number;
}

export function initiateRollback(
  opts: InitiateRollbackOptions,
): InitiateRollbackResult {
  if (isChangeFrozen()) {
    throw Object.assign(
      new Error("Rollbacks are frozen by change-freeze policy"),
      { code: "CHANGE_FREEZE" },
    );
  }

  if (!opts.initiatorId || !opts.initiatorId.trim()) {
    throw Object.assign(new Error("initiatorId is required"), { code: "MISSING_ACTOR" });
  }

  if (!opts.reason || opts.reason.trim().length < 10) {
    throw Object.assign(
      new Error("A reason of at least 10 characters is required"),
      { code: "REASON_TOO_SHORT" },
    );
  }

  // Resolve target
  let target: PromotionHistoryEntry | null;
  if (opts.targetSnapshotId) {
    target = _history.find((h) => h.snapshotId === opts.targetSnapshotId) ?? null;
    if (!target) {
      throw Object.assign(
        new Error(`Snapshot ${opts.targetSnapshotId} not found in promotion history`),
        { code: "SNAPSHOT_NOT_FOUND" },
      );
    }
  } else {
    target = getPriorPromotion();
    if (!target) {
      throw Object.assign(
        new Error("No prior promotion found to roll back to"),
        { code: "NO_PRIOR_VERSION" },
      );
    }
  }

  // Check rollback-to-current
  const current = getLatestPromotion();
  if (current && target.snapshotId === current.snapshotId) {
    throw Object.assign(
      new Error("Target snapshot is already the current champion — nothing to roll back"),
      { code: "ALREADY_CURRENT" },
    );
  }

  const rollbackId = `rbk-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const pending: PendingRollback = {
    rollbackId,
    targetSnapshotId: target.snapshotId,
    targetRequest: target.request,
    initiatorId: opts.initiatorId.trim(),
    reason: opts.reason.trim(),
    expiresAt: Date.now() + ROLLBACK_TTL_MS,
  };
  _pendingRollbacks.set(rollbackId, pending);

  return {
    rollbackId,
    targetSnapshotId: target.snapshotId,
    expiresAt: pending.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Dual-admin approve
// ---------------------------------------------------------------------------

export interface ApproveRollbackOptions {
  rollbackId: string;
  approverId: string;
  redis?: RedisClient | null;
}

/**
 * Complete the dual-admin rollback.
 *
 * Propagation is synchronous: `registry.promote(...)` rebuilds the routing
 * snapshot in-process, so all new requests see the reverted version
 * immediately — well within the 60-second SLO.
 */
export async function approveRollback(
  opts: ApproveRollbackOptions,
): Promise<RollbackResult> {
  if (!opts.approverId || !opts.approverId.trim()) {
    throw Object.assign(new Error("approverId is required"), { code: "MISSING_ACTOR" });
  }

  const pending = _pendingRollbacks.get(opts.rollbackId);
  if (!pending) {
    throw Object.assign(
      new Error(`No pending rollback request found: ${opts.rollbackId}`),
      { code: "NOT_FOUND" },
    );
  }

  // TTL check
  if (Date.now() > pending.expiresAt) {
    _pendingRollbacks.delete(opts.rollbackId);
    throw Object.assign(new Error("Rollback request has expired"), { code: "EXPIRED" });
  }

  // Dual-admin check
  if (opts.approverId.trim() === pending.initiatorId) {
    throw Object.assign(
      new Error("Approver must be a different admin from the initiator"),
      { code: "SAME_ADMIN" },
    );
  }

  if (isChangeFrozen()) {
    throw Object.assign(
      new Error("Rollbacks are frozen by change-freeze policy"),
      { code: "CHANGE_FREEZE" },
    );
  }

  // Remove the pending request before mutating state so concurrent
  // approve calls cannot race.
  _pendingRollbacks.delete(opts.rollbackId);

  const start = Date.now();
  const registry = getFraudModelRegistry();

  // Re-apply the prior snapshot's promotion request.
  const result = registry.promote(pending.targetRequest, opts.approverId.trim());

  // Record this rollback as a new promotion entry so subsequent rollbacks
  // can reference the state we just produced.
  const historyEntry: PromotionHistoryEntry = {
    snapshotId: result.snapshot.snapshotId,
    request: pending.targetRequest,
    promotedAt: new Date().toISOString(),
    promotedBy: opts.approverId.trim(),
  };
  recordPromotion(historyEntry, opts.redis);

  // Audit — fire-and-forget
  void defaultAuditLogger
    .log(
      "FRAUD_MODEL_ROLLBACK_APPLIED",
      {
        context: {
          rollbackId: opts.rollbackId,
          targetSnapshotId: pending.targetSnapshotId,
          initiatorId: pending.initiatorId,
          approverId: opts.approverId.trim(),
          reason: pending.reason,
          newSnapshotId: result.snapshot.snapshotId,
          propagationMs: Date.now() - start,
        },
      },
      { status: 200 },
    )
    .catch(() => {});

  return {
    snapshotId: result.snapshot.snapshotId,
    versions: Array.from(result.snapshot.versions),
    propagationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export function getPromotionHistory(): PromotionHistoryEntry[] {
  return [..._history];
}

export function getPendingRollback(rollbackId: string): PendingRollback | undefined {
  return _pendingRollbacks.get(rollbackId);
}
