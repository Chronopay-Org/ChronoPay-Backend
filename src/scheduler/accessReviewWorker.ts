/**
 * SOC2 Access Review Worker
 *
 * A recurring background job that:
 *   1. Takes access grant snapshots at the start of each quarter
 *   2. Detects gaps in quarterly coverage
 *   3. Generates attestation-ready reports
 *
 * The worker is designed to be started from the app bootstrap and can be
 * configured via environment variables.
 *
 * Security:
 *   - All actions are audited via AuditLogger
 *   - Snapshots are immutable once created
 *   - Reports are generated on-demand, not stored long-term
 *
 * Configuration (via env):
 *   ACCESS_REVIEW_INTERVAL_MS – How often to check if a snapshot is needed (default: 24h)
 *   ACCESS_REVIEW_LOOKBACK   – How many quarters to check for gaps (default: 8)
 */

import { accessReviewService } from "../services/accessReviewService.js";

// ─── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_LOOKBACK = 8;

function resolveInterval(): number {
  const raw = process.env.ACCESS_REVIEW_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 60_000 ? parsed : DEFAULT_INTERVAL_MS;
}

function resolveLookback(): number {
  const raw = process.env.ACCESS_REVIEW_LOOKBACK;
  if (!raw) return DEFAULT_LOOKBACK;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 40 ? parsed : DEFAULT_LOOKBACK;
}

// ─── Worker State ─────────────────────────────────────────────────────────────

let intervalTimer: NodeJS.Timeout | null = null;
let running = false;

// ─── Core Logic ───────────────────────────────────────────────────────────────

/**
 * Perform a single access review check:
 * - Create a snapshot for the current quarter if one doesn't exist
 * - Detect gaps in quarterly coverage
 */
export async function runAccessReviewCheck(): Promise<{
  snapshotCreated: boolean;
  snapshotId: string | null;
  gapCount: number;
}> {
  const beforeCount = accessReviewService.listSnapshots({ quarterLabel: computeQuarterLabel() }).total;

  // Create a snapshot for the current quarter (if it doesn't already exist)
  const snapshot = await accessReviewService.createSnapshot(false);
  const snapshotId = snapshot.snapshotId;

  // A snapshot was created if the count increased (meaning no existing one was returned)
  const afterCount = accessReviewService.listSnapshots({ quarterLabel: snapshot.quarterLabel }).total;
  const snapshotCreated = afterCount > beforeCount;

  // Detect gaps
  const gaps = accessReviewService.detectGaps(resolveLookback());

  return {
    snapshotCreated,
    snapshotId,
    gapCount: gaps.missingQuarters.length,
  };
}

function computeQuarterLabel(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = date.getMonth();
  const quarter = Math.floor(month / 3) + 1;
  return `${year}-Q${quarter}`;
}

// ─── Scheduler Lifecycle ──────────────────────────────────────────────────────

/**
 * Start the access review worker.
 * It will periodically check if a new snapshot is needed.
 */
export function startAccessReviewWorker(intervalMs?: number): void {
  if (running) return;
  running = true;

  const ms = intervalMs ?? resolveInterval();

  // Run one check immediately on startup
  void runAccessReviewCheck();

  // Then run at the configured interval
  intervalTimer = setInterval(() => {
    void runAccessReviewCheck();
  }, ms);

  // Allow the process to exit even if this timer is still active
  if (intervalTimer && typeof intervalTimer === "object" && "unref" in intervalTimer) {
    intervalTimer.unref();
  }
}

/**
 * Stop the access review worker.
 */
export function stopAccessReviewWorker(): void {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  running = false;
}

/**
 * Check if the worker is currently running.
 */
export function isAccessReviewWorkerRunning(): boolean {
  return running;
}
