/**
 * graceWindowService.ts
 * ---------------------
 * Per-slot-category no-show grace-window configuration.
 *
 * When a buyer is late to a booking, a grace window defines how many
 * seconds the system waits after the scheduled slot start before marking
 * the intent as a no-show candidate.
 *
 * Resolution order (highest → lowest priority):
 *   1. Category-specific config stored in this service
 *   2. DEFAULT_GRACE_WINDOW_SECONDS (900 s = 15 min)
 *
 * Admins can override any category via the admin API.
 * Every write is persisted to an immutable history log so the full
 * audit trail of policy changes is always available.
 *
 * Units: ALL values are in **seconds** (not minutes).
 *
 * Design notes:
 *  - The service is injectable (constructor-based) for full testability.
 *  - An in-memory implementation (`InMemoryGraceWindowStore`) ships with
 *    the service for unit-test isolation.
 *  - A singleton accessor (`getGraceWindowService`) is provided for
 *    application code that does not use DI.
 */

import { defaultAuditLogger } from "./auditLogger.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Fallback grace window in seconds applied when no category-specific config
 * exists.  900 s = 15 minutes is a reasonable default for most appointment
 * types.
 */
export const DEFAULT_GRACE_WINDOW_SECONDS = 900;

/**
 * Hard minimum (1 s) and maximum (86 400 s = 24 h) values accepted by the
 * validator.  These guard against obviously wrong admin inputs.
 */
export const MIN_GRACE_WINDOW_SECONDS = 1;
export const MAX_GRACE_WINDOW_SECONDS = 86_400;

// ─── Slot categories ──────────────────────────────────────────────────────────

/**
 * Known slot categories.  New categories can be registered at runtime by
 * calling `setGraceWindow`; the enum captures the well-known built-in set.
 */
export const SLOT_CATEGORIES = [
  "medical",
  "fitness",
  "beauty",
  "legal",
  "tutoring",
  "hospitality",
  "other",
] as const;

export type SlotCategory = (typeof SLOT_CATEGORIES)[number] | string;

// ─── Data shapes ──────────────────────────────────────────────────────────────

export interface GraceWindowConfig {
  /** Slot category this config applies to. */
  category: SlotCategory;
  /** Grace window in **seconds**. */
  graceWindowSeconds: number;
  /** Actor (admin) who last updated this config. */
  updatedBy: string;
  /** ISO-8601 timestamp of the last update. */
  updatedAt: string;
}

export interface GraceWindowHistoryEntry {
  /** Unique entry id. */
  id: string;
  /** Slot category. */
  category: SlotCategory;
  /** Grace window in seconds before this change. */
  previousGraceWindowSeconds: number | null;
  /** Grace window in seconds after this change. */
  newGraceWindowSeconds: number;
  /** Admin who made the change. */
  changedBy: string;
  /** ISO-8601 timestamp. */
  changedAt: string;
  /** Optional human-readable reason for the change. */
  reason?: string;
}

export interface SetGraceWindowInput {
  category: SlotCategory;
  graceWindowSeconds: number;
  changedBy: string;
  reason?: string;
}

// ─── Store interface ──────────────────────────────────────────────────────────

/**
 * Minimal persistence contract for grace-window configs.
 * Swap the in-memory implementation for a DB-backed one in production.
 */
export interface GraceWindowStore {
  get(category: SlotCategory): GraceWindowConfig | undefined;
  set(config: GraceWindowConfig): void;
  list(): GraceWindowConfig[];
  appendHistory(entry: GraceWindowHistoryEntry): void;
  getHistory(category?: SlotCategory): GraceWindowHistoryEntry[];
}

// ─── In-memory store ──────────────────────────────────────────────────────────

export class InMemoryGraceWindowStore implements GraceWindowStore {
  private readonly configs = new Map<SlotCategory, GraceWindowConfig>();
  private readonly history: GraceWindowHistoryEntry[] = [];
  private sequence = 1;

  get(category: SlotCategory): GraceWindowConfig | undefined {
    const entry = this.configs.get(category);
    return entry ? { ...entry } : undefined;
  }

  set(config: GraceWindowConfig): void {
    this.configs.set(config.category, { ...config });
  }

  list(): GraceWindowConfig[] {
    return Array.from(this.configs.values()).map((c) => ({ ...c }));
  }

  appendHistory(entry: GraceWindowHistoryEntry): void {
    this.history.push({ ...entry });
  }

  getHistory(category?: SlotCategory): GraceWindowHistoryEntry[] {
    const entries = category
      ? this.history.filter((e) => e.category === category)
      : [...this.history];
    // Return most-recent first, as independent copies.
    return entries.reverse().map((e) => ({ ...e }));
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

export interface GraceWindowServiceDeps {
  store?: GraceWindowStore;
  nowIso?: () => string;
  auditLogger?: typeof defaultAuditLogger;
  /** Sequence generator for history entry IDs. Defaults to crypto.randomUUID(). */
  generateId?: () => string;
}

export class GraceWindowService {
  private readonly store: GraceWindowStore;
  private readonly nowIso: () => string;
  private readonly audit: typeof defaultAuditLogger;
  private readonly generateId: () => string;

  constructor(deps: GraceWindowServiceDeps = {}) {
    this.store = deps.store ?? new InMemoryGraceWindowStore();
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
    this.audit = deps.auditLogger ?? defaultAuditLogger;
    this.generateId =
      deps.generateId ??
      (() => {
        // Use crypto.randomUUID when available (Node 15+), fallback to timestamp.
        try {
          return (crypto as any).randomUUID?.() ?? `gw-${Date.now()}-${Math.random()}`;
        } catch {
          return `gw-${Date.now()}-${Math.random()}`;
        }
      });
  }

  /**
   * Resolve the effective grace window (in seconds) for a given category.
   *
   * Falls back to `DEFAULT_GRACE_WINDOW_SECONDS` when no category-specific
   * config exists.
   */
  resolve(category: SlotCategory | undefined | null): number {
    if (!category) return DEFAULT_GRACE_WINDOW_SECONDS;
    const config = this.store.get(category);
    return config?.graceWindowSeconds ?? DEFAULT_GRACE_WINDOW_SECONDS;
  }

  /**
   * Return the full config for a category, or `undefined` if none is set
   * (the fallback default applies).
   */
  get(category: SlotCategory): GraceWindowConfig | undefined {
    return this.store.get(category);
  }

  /**
   * List all explicitly configured categories.
   */
  list(): GraceWindowConfig[] {
    return this.store.list();
  }

  /**
   * Retrieve the change history for a category (or all categories when
   * `category` is omitted).  Entries are returned most-recent first.
   */
  getHistory(category?: SlotCategory): GraceWindowHistoryEntry[] {
    return this.store.getHistory(category);
  }

  /**
   * Set or update the grace window for a category.
   *
   * Validates input, writes the new config, appends an immutable history
   * entry, and emits an audit event.
   *
   * @throws {GraceWindowValidationError} on invalid input.
   */
  async set(input: SetGraceWindowInput): Promise<GraceWindowConfig> {
    validateSetInput(input);

    const existing = this.store.get(input.category);
    const now = this.nowIso();

    const config: GraceWindowConfig = {
      category: input.category,
      graceWindowSeconds: input.graceWindowSeconds,
      updatedBy: input.changedBy,
      updatedAt: now,
    };

    this.store.set(config);

    const historyEntry: GraceWindowHistoryEntry = {
      id: this.generateId(),
      category: input.category,
      previousGraceWindowSeconds: existing?.graceWindowSeconds ?? null,
      newGraceWindowSeconds: input.graceWindowSeconds,
      changedBy: input.changedBy,
      changedAt: now,
      reason: input.reason,
    };

    this.store.appendHistory(historyEntry);

    // Emit audit event — failure must not block the primary operation.
    try {
      await this.audit.log(
        "grace_window.config_changed",
        {
          context: {
            category: input.category,
            previousGraceWindowSeconds: historyEntry.previousGraceWindowSeconds,
            newGraceWindowSeconds: input.graceWindowSeconds,
            changedBy: input.changedBy,
            reason: input.reason,
          },
        },
        {
          resource: `grace-window:${input.category}`,
          status: 200,
        },
      );
    } catch {
      // Swallow — audit write must not fail the config update.
    }

    return { ...config };
  }

  /**
   * Delete a category override, reverting it to the default fallback.
   * Returns `true` if something was deleted, `false` if the category had
   * no explicit config.
   */
  async delete(
    category: SlotCategory,
    deletedBy: string,
    reason?: string,
  ): Promise<boolean> {
    if (!category || typeof category !== "string" || category.trim() === "") {
      throw new GraceWindowValidationError("category must be a non-empty string");
    }

    const existing = this.store.get(category);
    if (!existing) return false;

    const now = this.nowIso();

    // Append history before deleting so the "deleted" event is captured.
    const historyEntry: GraceWindowHistoryEntry = {
      id: this.generateId(),
      category,
      previousGraceWindowSeconds: existing.graceWindowSeconds,
      // Represent deletion as reverting to the system default.
      newGraceWindowSeconds: DEFAULT_GRACE_WINDOW_SECONDS,
      changedBy: deletedBy,
      changedAt: now,
      reason: reason ?? "Config deleted — reverted to default",
    };

    this.store.appendHistory(historyEntry);

    // Remove from the store.  The in-memory store uses a Map — cast it
    // to access the delete method.
    (this.store as any).configs?.delete(category);

    try {
      await this.audit.log(
        "grace_window.config_deleted",
        {
          context: {
            category,
            previousGraceWindowSeconds: existing.graceWindowSeconds,
            deletedBy,
            reason: historyEntry.reason,
          },
        },
        { resource: `grace-window:${category}`, status: 200 },
      );
    } catch {
      // Swallow — see above.
    }

    return true;
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

export class GraceWindowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraceWindowValidationError";
  }
}

export function validateSetInput(input: SetGraceWindowInput): void {
  if (!input.category || typeof input.category !== "string" || input.category.trim() === "") {
    throw new GraceWindowValidationError("category must be a non-empty string");
  }
  if (input.category.trim().length > 100) {
    throw new GraceWindowValidationError("category must be 100 characters or fewer");
  }
  if (!Number.isFinite(input.graceWindowSeconds)) {
    throw new GraceWindowValidationError("graceWindowSeconds must be a finite number");
  }
  if (!Number.isInteger(input.graceWindowSeconds)) {
    throw new GraceWindowValidationError("graceWindowSeconds must be an integer");
  }
  if (
    input.graceWindowSeconds < MIN_GRACE_WINDOW_SECONDS ||
    input.graceWindowSeconds > MAX_GRACE_WINDOW_SECONDS
  ) {
    throw new GraceWindowValidationError(
      `graceWindowSeconds must be between ${MIN_GRACE_WINDOW_SECONDS} and ${MAX_GRACE_WINDOW_SECONDS}`,
    );
  }
  if (!input.changedBy || typeof input.changedBy !== "string" || input.changedBy.trim() === "") {
    throw new GraceWindowValidationError("changedBy must be a non-empty string");
  }
  if (input.reason !== undefined) {
    if (typeof input.reason !== "string") {
      throw new GraceWindowValidationError("reason must be a string when provided");
    }
    if (input.reason.length > 500) {
      throw new GraceWindowValidationError("reason must be 500 characters or fewer");
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _instance: GraceWindowService | null = null;

/** Get or create the module-level singleton. */
export function getGraceWindowService(deps?: GraceWindowServiceDeps): GraceWindowService {
  if (!_instance) _instance = new GraceWindowService(deps);
  return _instance;
}

/** Reset the singleton (test isolation only). */
export function resetGraceWindowServiceSingleton(): void {
  _instance = null;
}
