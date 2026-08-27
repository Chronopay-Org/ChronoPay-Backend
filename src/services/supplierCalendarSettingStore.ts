// @ts-nocheck
/**
 * Supplier Calendar Setting Store
 *
 * Manages per-supplier opt-in/opt-out for the `slot.changed` webhook.
 * Each supplier can enable or disable calendar sync independently.
 *
 * Storage:
 * - In-memory store (can be swapped for a database-backed store in production).
 * - Thread-safe via single-process Node.js event loop.
 *
 * Contract:
 * - `isEnabled(supplierId)` returns `false` for unknown suppliers (opt-out by default).
 * - `setEnabled(supplierId, enabled)` upserts the setting.
 * - `getSetting(supplierId)` returns the full setting or `null` if not configured.
 * - `listEnabled()` returns all suppliers with calendar sync enabled.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SupplierCalendarSetting {
  /** Supplier identifier. */
  supplierId: string;
  /** Whether calendar sync is enabled for this supplier. */
  enabled: boolean;
  /** ISO 8601 timestamp when the setting was last updated. */
  updatedAt: string;
  /** Optional: webhook endpoint URL override for this supplier. */
  webhookUrl?: string;
  /** Optional: signing secret for this supplier's webhook. */
  signingSecret?: string;
}

// ─── In-memory store ───────────────────────────────────────────────────────

const settings = new Map<string, SupplierCalendarSetting>();

// ─── Store API ─────────────────────────────────────────────────────────────

export const SupplierCalendarSettingStore = {
  /**
   * Check if calendar sync is enabled for a supplier.
   * Returns `false` for unknown suppliers (opt-out by default).
   */
  isEnabled(supplierId: string): boolean {
    if (typeof supplierId !== "string" || supplierId.trim().length === 0) {
      return false;
    }
    const setting = settings.get(supplierId.trim());
    return setting?.enabled === true;
  },

  /**
   * Enable or disable calendar sync for a supplier.
   * Creates a new setting if one doesn't exist (upsert).
   */
  setEnabled(
    supplierId: string,
    enabled: boolean,
    options?: { webhookUrl?: string; signingSecret?: string },
  ): SupplierCalendarSetting {
    if (typeof supplierId !== "string" || supplierId.trim().length === 0) {
      throw new Error("supplierId must be a non-empty string");
    }

    const id = supplierId.trim();
    const existing = settings.get(id);

    const setting: SupplierCalendarSetting = {
      supplierId: id,
      enabled: Boolean(enabled),
      updatedAt: new Date().toISOString(),
      webhookUrl: options?.webhookUrl ?? existing?.webhookUrl,
      signingSecret: options?.signingSecret ?? existing?.signingSecret,
    };

    settings.set(id, setting);
    return { ...setting };
  },

  /**
   * Get the full calendar setting for a supplier.
   * Returns `null` if no setting exists.
   */
  getSetting(supplierId: string): SupplierCalendarSetting | null {
    if (typeof supplierId !== "string" || supplierId.trim().length === 0) {
      return null;
    }
    const setting = settings.get(supplierId.trim());
    return setting ? { ...setting } : null;
  },

  /**
   * Remove a supplier's calendar setting entirely.
   * After removal, the supplier defaults to opt-out.
   */
  remove(supplierId: string): boolean {
    if (typeof supplierId !== "string" || supplierId.trim().length === 0) {
      return false;
    }
    return settings.delete(supplierId.trim());
  },

  /**
   * List all suppliers with calendar sync enabled.
   */
  listEnabled(): SupplierCalendarSetting[] {
    return Array.from(settings.values())
      .filter((s) => s.enabled)
      .map((s) => ({ ...s }));
  },

  /**
   * Clear all settings. Used for testing.
   */
  clear(): void {
    settings.clear();
  },

  /**
   * Get the count of configured suppliers.
   */
  size(): number {
    return settings.size;
  },
};
