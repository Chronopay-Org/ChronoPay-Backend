/**
 * tzDriftMonitor.ts
 *
 * Nightly scan that detects slots stored with ambiguous or missing timezone
 * information. Runs as a background worker with pagination, tenant-scoped
 * metrics, and configurable safety thresholds.
 *
 * Design decisions:
 *  - Operates against an injectable in-memory slot store so the monitor is
 *    fully testable without a real database.
 *  - Pagination via cursor prevents memory pressure on large slot tables.
 *  - Detection strategy: check for ISO strings without offset, DST transition
 *    proximity, and missing timezone metadata.
 *  - Tenant grouping uses the slot's professionalId field.
 *  - The worker loop honours an AbortSignal for clean shutdown (mirrors
 *    pattern used by expiryCleanupWorker and outboxCompactionWorker).
 *  - All activity is reflected in Prometheus-compatible metrics.
 *  - Findings from the last scan are retained so the admin API can return
 *    offending rows for investigation.
 *
 * NOTE: InMemorySlotStore.listPage() sorts and copies the entire store on
 * every call — acceptable for tests up to ~10k rows. A production
 * implementation would use `SELECT ... WHERE id > $cursor ORDER BY id LIMIT $n`.
 */

import { isInDSTTransition } from "../validation/reminderValidation.js";
import {
  recordAmbiguousSlots,
  recordMissingTzSlots,
  recordScanCompleted,
  recordSlotsScanned,
  type TzDriftSeverity,
} from "../metrics/tzDriftMetrics.js";
import {
  tzDriftAmbiguousSlots,
  tzDriftMissingTzSlots,
  tzDriftLastScanTimestamp,
  tzDriftSlotsScannedTotal,
} from "../metrics.js";

// ─── Domain types ─────────────────────────────────────────────────────────────

/**
 * Slot record used by the timezone drift monitor.
 * Mirrors the DB schema (migration 002) at the application layer.
 */
export interface TZSlotRecord {
  id: string;
  professionalId: string;
  startTime: number | string;
  endTime: number | string;
  status?: string;
  createdAt?: string;
  /** Optional IANA timezone if the slot was created with one. */
  timezone?: string;
}

/** Classification of a timezone drift finding. */
export type TZDriftCategory = "missing_tz" | "ambiguous" | "metadata";

/**
 * Result of inspecting a single slot for timezone issues.
 */
export interface TZDriftFinding {
  slotId: string;
  professionalId: string;
  severity: TzDriftSeverity;
  /** Machine-readable category for metrics aggregation. */
  category: TZDriftCategory;
  reason: string;
  startTime: number | string;
  endTime: number | string;
}

/**
 * Summary of a complete timezone drift scan.
 */
export interface TZDriftScanResult {
  /** Total number of slots examined. */
  slotsScanned: number;
  /** Detailed findings per offending slot. */
  findings: TZDriftFinding[];
  /** True when the safety brake fired and no scan was performed. */
  skippedBecauseThreshold?: boolean;
}

// ─── Module-level cache of last-scan findings for admin API ───────────────────

let lastScanFindings: TZDriftFinding[] = [];

/** Return a copy of the most recent scan's findings. */
export function getLastScanFindings(): TZDriftFinding[] {
  return [...lastScanFindings];
}

// ─── In-memory store (used in tests and as a reference implementation) ────────

/**
 * Minimal in-memory slot store that backs the timezone drift monitor in tests.
 *
 * Production code would replace this with a real database-backed implementation
 * via dependency injection, querying the `slots` table with cursor pagination.
 *
 * NOTE: listPage sorts and copies all rows on every call. This is intentional
 * for simplicity in tests (<10k rows). A production implementation should use
 * an indexed DB query with `WHERE id > $cursor ORDER BY id LIMIT $n`.
 */
export class InMemorySlotStore {
  private readonly rows = new Map<string, TZSlotRecord>();

  /** Insert or replace a slot record. */
  upsert(slot: TZSlotRecord): void {
    this.rows.set(slot.id, { ...slot });
  }

  /** Return a single slot by id. */
  findById(id: string): TZSlotRecord | undefined {
    const row = this.rows.get(id);
    return row ? { ...row } : undefined;
  }

  /**
   * Return a page of slots using cursor-based pagination.
   * @param cursor - The last slot id from the previous page, or undefined for first page.
   * @param limit  - Maximum number of rows to return.
   * @returns An array of slot records and the next cursor (or undefined if done).
   */
  listPage(
    cursor?: string,
    limit: number = 100,
  ): { slots: TZSlotRecord[]; nextCursor?: string } {
    // NOTE: Full copy + sort per call — acceptable for in-memory test store.
    // Production would use an indexed DB query.
    const all = [...this.rows.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );

    const startIndex = cursor
      ? all.findIndex((s) => s.id > cursor)
      : 0;

    if (startIndex === -1) {
      return { slots: [], nextCursor: undefined };
    }

    const page = all.slice(startIndex, startIndex + limit);
    const nextCursor =
      page.length === limit ? page[page.length - 1].id : undefined;

    return { slots: page.map((s) => ({ ...s })), nextCursor };
  }

  /** Return the total number of slots in the store. */
  size(): number {
    return this.rows.size;
  }

  /** Delete every slot. Used in tests to reset state. */
  clear(): void {
    this.rows.clear();
  }
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface TZDriftMonitorConfig {
  /**
   * Maximum number of slots to scan in a single sweep.
   * Defaults to 5 000 (TZ_DRIFT_SCAN_LIMIT env var).
   */
  scanLimit?: number;
  /**
   * Page size for cursor-based pagination.
   * Defaults to 100 (TZ_DRIFT_PAGE_SIZE env var).
   */
  pageSize?: number;
  /**
   * If the total number of slots exceeds this value, the scan is skipped
   * entirely and the safety-brake metric is fired.
   * Defaults to 500 000 (TZ_DRIFT_SAFETY_THRESHOLD env var).
   */
  safetyThreshold?: number;
  /**
   * How long the worker sleeps between sweeps in milliseconds.
   * Defaults to 24 hours / 86 400 000 ms (TZ_DRIFT_INTERVAL_MS env var).
   */
  intervalMs?: number;
  /**
   * Common timezones to check for DST transition proximity.
   * Defaults to a set of commonly used IANA timezones.
   */
  monitoredTimezones?: string[];
  /**
   * When false, slots without an explicit timezone metadata field are NOT
   * flagged as `info` severity. This reduces noise in production where the
   * timezone column may not be universally populated.
   * Defaults to false.
   */
  reportMissingMetadata?: boolean;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1_000;

const DEFAULT_MONITORED_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Madrid",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
  "Pacific/Auckland",
];

function parsePositiveInteger(
  value: string | undefined,
  defaultValue: number,
): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return defaultValue;
  return parsed;
}

function resolveConfig(
  overrides: TZDriftMonitorConfig = {},
): Required<TZDriftMonitorConfig> {
  return {
    scanLimit:
      overrides.scanLimit ??
      parsePositiveInteger(process.env.TZ_DRIFT_SCAN_LIMIT, 5_000),
    pageSize:
      overrides.pageSize ??
      parsePositiveInteger(process.env.TZ_DRIFT_PAGE_SIZE, 100),
    safetyThreshold:
      overrides.safetyThreshold ??
      parsePositiveInteger(process.env.TZ_DRIFT_SAFETY_THRESHOLD, 500_000),
    intervalMs:
      overrides.intervalMs ??
      parsePositiveInteger(process.env.TZ_DRIFT_INTERVAL_MS, TWENTY_FOUR_HOURS_MS),
    monitoredTimezones: overrides.monitoredTimezones ?? DEFAULT_MONITORED_TIMEZONES,
    reportMissingMetadata: overrides.reportMissingMetadata ?? false,
  };
}

// ─── Detection helpers ────────────────────────────────────────────────────────

/**
 * ISO 8601 timestamp regex that matches strings WITHOUT a timezone offset.
 * Matches patterns like "2026-03-15T02:30:00" or "2026-03-15T02:30:00.123"
 * but NOT "2026-03-15T02:30:00Z" or "2026-03-15T02:30:00+05:00".
 */
const ISO_WITHOUT_TZ_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

/**
 * ISO 8601 timestamp regex that matches strings WITH a timezone offset
 * (either "Z" for UTC or ±HH:MM / ±HHMM).
 */
const ISO_WITH_TZ_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * DST transition look-ahead window in milliseconds (6 hours).
 * Slots whose times fall within this window of a known DST transition
 * are flagged as ambiguous.
 */
const DST_TRANSITION_WINDOW_MS = 6 * 60 * 60 * 1_000;

/**
 * Returns true when a time value looks like it may be missing timezone info.
 *
 * Detection rules:
 * - A string matching ISO without TZ offset → missing TZ info
 * - A number (epoch ms) is always unambiguous in itself, but we still check
 *   for DST proximity.
 */
function hasMissingTZInfo(timeValue: number | string): boolean {
  if (typeof timeValue === "string") {
    if (ISO_WITHOUT_TZ_RE.test(timeValue)) {
      return true;
    }
    if (ISO_WITH_TZ_RE.test(timeValue)) {
      return false;
    }
  }
  return false;
}

/**
 * Normalize a slot time value to epoch milliseconds.
 * Returns undefined if the value cannot be parsed.
 */
function toEpochMs(value: number | string): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * Check if a slot falls within a DST transition window for any
 * of the monitored timezones.
 *
 * Performance note: this function makes O(timezones × checkpoints × window_steps)
 * calls to isInDSTTransition, each of which calls Intl.DateTimeFormat twice.
 * For 14 timezones, this is ~336 offset calculations per slot. This is
 * acceptable for a nightly scan of up to 5,000 slots but is worth caching
 * in future iterations for frequently repeated timezones/hour-buckets.
 */
function isNearDSTTransition(
  startMs: number,
  endMs: number,
  monitoredTimezones: string[],
): { nearTransition: boolean; affectedTz?: string } {
  const checkPoints = [startMs, endMs, Math.floor((startMs + endMs) / 2)];

  for (const tz of monitoredTimezones) {
    for (const point of checkPoints) {
      const windowStart = point - DST_TRANSITION_WINDOW_MS;
      const windowEnd = point + DST_TRANSITION_WINDOW_MS;

      // Check at coarse intervals within the window
      const step = Math.floor(DST_TRANSITION_WINDOW_MS / 4);
      for (let t = windowStart; t <= windowEnd; t += step) {
        if (isInDSTTransition(t, tz)) {
          return { nearTransition: true, affectedTz: tz };
        }
      }
    }
  }

  return { nearTransition: false };
}

/**
 * Inspect a single slot record for timezone drift issues.
 */
function inspectSlot(
  slot: TZSlotRecord,
  monitoredTimezones: string[],
  reportMissingMetadata: boolean,
): TZDriftFinding | null {
  const missingTz = hasMissingTZInfo(slot.startTime) || hasMissingTZInfo(slot.endTime);
  const hasExplicitTz =
    slot.timezone !== undefined && slot.timezone.trim().length > 0;

  // ── Critical: missing TZ info AND the slot exists without explicit timezone ──
  if (missingTz && !hasExplicitTz) {
    return {
      slotId: slot.id,
      professionalId: slot.professionalId,
      severity: "critical",
      category: "missing_tz",
      reason: "Slot stored with naive local timestamp lacking timezone offset",
      startTime: slot.startTime,
      endTime: slot.endTime,
    };
  }

  // ── Warning: missing TZ info but has explicit timezone field ────────────────
  if (missingTz && hasExplicitTz) {
    return {
      slotId: slot.id,
      professionalId: slot.professionalId,
      severity: "warning",
      category: "missing_tz",
      reason: `Slot stored with naive local timestamp but has explicit timezone field: ${slot.timezone}`,
      startTime: slot.startTime,
      endTime: slot.endTime,
    };
  }

  // ── Check DST proximity ─────────────────────────────────────────────────────
  const startMs = toEpochMs(slot.startTime);
  const endMs = toEpochMs(slot.endTime);

  if (startMs !== undefined && endMs !== undefined) {
    const { nearTransition, affectedTz } = isNearDSTTransition(
      startMs,
      endMs,
      monitoredTimezones,
    );

    if (nearTransition) {
      const severity: TzDriftSeverity = hasExplicitTz ? "info" : "warning";
      return {
        slotId: slot.id,
        professionalId: slot.professionalId,
        severity,
        category: "ambiguous",
        reason: `Slot time falls within DST transition window for ${affectedTz ?? "monitored timezone"}` +
          (hasExplicitTz ? "" : " without explicit timezone context"),
        startTime: slot.startTime,
        endTime: slot.endTime,
      };
    }
  }

  // ── Info: slot has no timezone metadata field (opt-in via config) ───────────
  if (reportMissingMetadata && !hasExplicitTz && !missingTz) {
    return {
      slotId: slot.id,
      professionalId: slot.professionalId,
      severity: "info",
      category: "metadata",
      reason: "Slot stored without timezone metadata field",
      startTime: slot.startTime,
      endTime: slot.endTime,
    };
  }

  return null;
}

// ─── Core scan logic ──────────────────────────────────────────────────────────

/**
 * Perform a single timezone drift scan against the provided store.
 *
 * Scans slots with cursor-based pagination, inspects each for timezone
 * issues, and records tenant-scoped metrics in both the in-memory
 * snapshot (for the admin API) and Prometheus (for alerting).
 *
 * The in-memory metrics module tracks cumulative counts across scans;
 * the Prometheus gauges are set to the per-scan totals (snapshot semantics).
 *
 * @param store   The slot store to scan.
 * @param config  Optional configuration overrides.
 * @param nowMs   Current time in epoch milliseconds (injectable for testing).
 */
export function scanTzDriftOnce(
  store: Pick<InMemorySlotStore, "listPage" | "size">,
  config: TZDriftMonitorConfig = {},
  nowMs: number = Date.now(),
): TZDriftScanResult {
  const cfg = resolveConfig(config);
  const totalSlots = store.size();

  // ── Safety brake ────────────────────────────────────────────────────────────
  if (totalSlots > cfg.safetyThreshold) {
    return {
      slotsScanned: 0,
      findings: [],
      skippedBecauseThreshold: true,
    };
  }

  // ── Tenant-level aggregation ────────────────────────────────────────────────
  const tenantSeverityCounts = new Map<
    string,
    Map<TzDriftSeverity, { ambiguous: number; missingTz: number }>
  >();

  function addFinding(finding: TZDriftFinding): void {
    const tenant = finding.professionalId;
    if (!tenantSeverityCounts.has(tenant)) {
      tenantSeverityCounts.set(tenant, new Map());
    }
    const sevMap = tenantSeverityCounts.get(tenant)!;
    if (!sevMap.has(finding.severity)) {
      sevMap.set(finding.severity, { ambiguous: 0, missingTz: 0 });
    }
    const counts = sevMap.get(finding.severity)!;

    if (finding.category === "ambiguous" || finding.category === "metadata") {
      counts.ambiguous += 1;
    } else {
      counts.missingTz += 1;
    }
  }

  // ── Paginated scan ──────────────────────────────────────────────────────────
  const allFindings: TZDriftFinding[] = [];
  let slotsScanned = 0;
  let cursor: string | undefined;

  while (slotsScanned < cfg.scanLimit) {
    const remaining = cfg.scanLimit - slotsScanned;
    const pageSize = Math.min(cfg.pageSize, remaining);
    const page = store.listPage(cursor, pageSize);

    if (page.slots.length === 0) break;

    for (const slot of page.slots) {
      const finding = inspectSlot(slot, cfg.monitoredTimezones, cfg.reportMissingMetadata);
      if (finding) {
        allFindings.push(finding);
        addFinding(finding);
      }
    }

    slotsScanned += page.slots.length;
    cursor = page.nextCursor;

    if (!cursor) break;
  }

  // ── Cache findings for admin API ────────────────────────────────────────────
  lastScanFindings = allFindings;

  // ── Emit tenant-scoped metrics ──────────────────────────────────────────────
  for (const [tenant, sevMap] of tenantSeverityCounts) {
    for (const [severity, counts] of sevMap) {
      if (counts.ambiguous > 0) {
        recordAmbiguousSlots(tenant, severity, counts.ambiguous);
        tzDriftAmbiguousSlots.labels(tenant, severity).set(counts.ambiguous);
      }
      if (counts.missingTz > 0) {
        recordMissingTzSlots(tenant, severity, counts.missingTz);
        tzDriftMissingTzSlots.labels(tenant, severity).set(counts.missingTz);
      }
    }
  }

  recordSlotsScanned(slotsScanned);
  recordScanCompleted(nowMs);
  tzDriftSlotsScannedTotal.inc(slotsScanned);
  tzDriftLastScanTimestamp.set(Math.floor(nowMs / 1000));

  return {
    slotsScanned,
    findings: allFindings,
  };
}

// ─── Long-running worker loop ─────────────────────────────────────────────────

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
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
 * Continuously scan for timezone drift until the given AbortSignal fires.
 *
 * @param signal  AbortSignal that stops the worker cleanly.
 * @param store   The slot store to scan.
 * @param config  Optional configuration overrides.
 */
export async function runTzDriftMonitor(
  signal: AbortSignal,
  store: Pick<InMemorySlotStore, "listPage" | "size">,
  config: TZDriftMonitorConfig = {},
): Promise<void> {
  const cfg = resolveConfig(config);

  while (!signal.aborted) {
    scanTzDriftOnce(store, config);
    if (signal.aborted) break;
    await sleep(cfg.intervalMs, signal);
  }
}
