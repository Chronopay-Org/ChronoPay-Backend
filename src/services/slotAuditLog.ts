/**
 * @file src/services/slotAuditLog.ts
 *
 * Slot Inventory Audit Log Service
 *
 * Provides:
 *  - SlotAuditRecord: the immutable audit schema
 *  - SlotAuditLogService: in-memory store with paginated query support
 *  - audit(): reusable helper that wraps a slot mutation, captures
 *    before/after state, and persists the audit record only after a
 *    successful mutation.
 *
 * Design notes:
 *  - Records are append-only.  No update/delete methods are exposed.
 *  - Actor identity always comes from the authenticated request context;
 *    client-supplied actor fields are ignored.
 *  - No-op updates (where the before and after state are identical) do
 *    NOT produce an audit record.
 *  - If the mutation throws, no audit record is written (rollback safety).
 *  - If audit persistence itself throws after a successful mutation, the
 *    error is re-thrown so the caller can handle it; the mutation result
 *    is not lost.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** The three audited slot mutation actions. */
export type SlotAuditAction = "create" | "update" | "delete";

/**
 * Immutable audit record.
 *
 * Fields align with the requirements in issue #599:
 *   - actor            authenticated admin identity (user ID)
 *   - timestamp        ISO-8601 creation time
 *   - action           create | update | delete
 *   - resourceId       the slot ID that was affected
 *   - before           slot state before the mutation (null for creates)
 *   - after            slot state after the mutation (null for deletes)
 *   - reason           mandatory human-readable justification (≥ 10 chars)
 *   - requestMeta      optional IP address / request ID from the HTTP layer
 */
export interface SlotAuditRecord {
  readonly id: string;
  readonly actor: string;
  readonly timestamp: string;
  readonly action: SlotAuditAction;
  readonly resourceId: string;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
  readonly reason: string;
  readonly requestMeta?: {
    readonly ip?: string;
    readonly requestId?: string;
  };
}

/** Options for listing audit records. */
export interface SlotAuditListOptions {
  /** Filter by actor (exact match). */
  actor?: string;
  /** Filter by action. */
  action?: SlotAuditAction;
  /** Filter by resource ID (exact match). */
  resourceId?: string;
  /** Only include records at or after this ISO-8601 date string. */
  since?: string;
  /** Only include records at or before this ISO-8601 date string. */
  until?: string;
  /** 1-based page number (default 1). */
  page?: number;
  /** Results per page, 1–200 (default 20). */
  limit?: number;
}

/** Paginated result from the audit feed. */
export interface SlotAuditListResult {
  data: SlotAuditRecord[];
  page: number;
  limit: number;
  total: number;
}

// ─── Validation helpers ───────────────────────────────────────────────────────

const REASON_MIN_LENGTH = 10;

/**
 * Validates and trims a reason string.
 *
 * @throws {SlotAuditValidationError} when the reason is absent, whitespace-only,
 *   or shorter than REASON_MIN_LENGTH characters after trimming.
 */
export function validateReason(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new SlotAuditValidationError("reason is required");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new SlotAuditValidationError("reason must not be empty or whitespace-only");
  }
  if (trimmed.length < REASON_MIN_LENGTH) {
    throw new SlotAuditValidationError(
      `reason must be at least ${REASON_MIN_LENGTH} characters`,
    );
  }
  return trimmed;
}

export class SlotAuditValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotAuditValidationError";
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

/** Generates a simple monotonic audit record ID. */
function newAuditId(counter: number): string {
  return `audit-${Date.now()}-${counter}`;
}

export class SlotAuditLogService {
  private _records: SlotAuditRecord[] = [];
  private _counter = 1;

  /**
   * Persists an audit record.
   *
   * Records are stored in insertion order (newest appended last).
   * The record is frozen to enforce immutability at runtime.
   */
  persist(record: Omit<SlotAuditRecord, "id" | "timestamp">): SlotAuditRecord {
    const entry: SlotAuditRecord = Object.freeze({
      id: newAuditId(this._counter++),
      timestamp: new Date().toISOString(),
      ...record,
    });
    this._records.push(entry);
    return entry;
  }

  /**
   * Returns paginated audit records, newest first.
   *
   * Supports optional filters: actor, action, resourceId, since, until.
   *
   * No-op updates are never stored, so they never appear here.
   */
  list(options: SlotAuditListOptions = {}): SlotAuditListResult {
    const {
      actor,
      action,
      resourceId,
      since,
      until,
      page = 1,
      limit = 20,
    } = options;

    const sinceMs = since ? new Date(since).getTime() : undefined;
    const untilMs = until ? new Date(until).getTime() : undefined;

    const filtered = this._records.filter((r) => {
      if (actor !== undefined && r.actor !== actor) return false;
      if (action !== undefined && r.action !== action) return false;
      if (resourceId !== undefined && r.resourceId !== resourceId) return false;
      if (sinceMs !== undefined) {
        const tMs = new Date(r.timestamp).getTime();
        if (tMs < sinceMs) return false;
      }
      if (untilMs !== undefined) {
        const tMs = new Date(r.timestamp).getTime();
        if (tMs > untilMs) return false;
      }
      return true;
    });

    // Newest first
    const sorted = filtered.slice().reverse();

    const total = sorted.length;
    const clampedLimit = Math.min(Math.max(limit, 1), 200);
    const clampedPage = Math.max(page, 1);
    const offset = (clampedPage - 1) * clampedLimit;
    const data = sorted.slice(offset, offset + clampedLimit);

    return { data, page: clampedPage, limit: clampedLimit, total };
  }

  /** Resets the store — for use in tests only. */
  reset(): void {
    this._records = [];
    this._counter = 1;
  }
}

/** Singleton instance shared across the application. */
export const slotAuditLogService = new SlotAuditLogService();

// ─── audit() helper ───────────────────────────────────────────────────────────

export interface AuditContext {
  actor: string;
  action: SlotAuditAction;
  resourceId: string;
  reason: string;
  requestMeta?: {
    ip?: string;
    requestId?: string;
  };
}

/**
 * Reusable audit helper.
 *
 * Execution order:
 *  1. Captures `before` state (result of `getBefore`).
 *  2. Executes `mutate()`.
 *  3. Captures `after` state (result of `getAfter`, called with mutation result).
 *  4. Detects no-ops: if before === after (deep equality), returns the result
 *     without writing an audit record.
 *  5. Persists the audit record.
 *  6. Returns the mutation result.
 *
 * Guarantees:
 *  - If `mutate()` throws, no audit record is written.
 *  - If `persist()` throws after a successful mutation, the error propagates
 *    to the caller; the caller is responsible for surfacing it appropriately.
 *
 * @param ctx         Audit metadata (actor, action, resourceId, reason, requestMeta)
 * @param getBefore   Async function that captures the resource state before mutation
 * @param mutate      Async function that performs the actual mutation; its return
 *                    value is forwarded to `getAfter` and returned to the caller
 * @param getAfter    Async function that captures the resource state after mutation;
 *                    receives the raw mutation result
 * @param service     Optional override of the singleton (useful for tests)
 */
export async function audit<T>(
  ctx: AuditContext,
  getBefore: () => Promise<Record<string, unknown> | null>,
  mutate: () => Promise<T>,
  getAfter: (result: T) => Promise<Record<string, unknown> | null>,
  service: SlotAuditLogService = slotAuditLogService,
): Promise<T> {
  const before = await getBefore();

  // ── Execute mutation ────────────────────────────────────────────────────────
  // If this throws, we do not write an audit record.
  const result = await mutate();

  const after = await getAfter(result);

  // ── Skip no-op updates ──────────────────────────────────────────────────────
  // If the serialised before and after states are identical, the update is a
  // no-op.  We return the result without creating an audit entry.
  if (before !== null && after !== null) {
    const beforeJson = JSON.stringify(before);
    const afterJson = JSON.stringify(after);
    if (beforeJson === afterJson) {
      return result;
    }
  }

  // ── Persist audit record ────────────────────────────────────────────────────
  service.persist({
    actor: ctx.actor,
    action: ctx.action,
    resourceId: ctx.resourceId,
    before,
    after,
    reason: ctx.reason,
    requestMeta: ctx.requestMeta,
  });

  return result;
}
