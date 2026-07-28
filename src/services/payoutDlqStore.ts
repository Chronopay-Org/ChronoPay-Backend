// src/services/payoutDlqStore.ts
import { v4 as uuidv4 } from "uuid";
import { redact } from "../utils/redact.js";

/** Status of a DLQ entry */
export type PayoutDlqStatus = "pending" | "reprocessed" | "inspected";

/** Represents a single dead-lettered payout entry */
export interface PayoutDlqEntry {
  /** Unique identifier for the DLQ entry */
  id: string;
  /** Supplier ID associated with the failed payout */
  supplierId: string;
  /** Error class/category (e.g., "NETWORK", "TIMEOUT", "INSUFFICIENT_FUNDS", "VALIDATION") */
  errorClass: string;
  /** Original error message (not the full stack) */
  errorMessage: string;
  /** The original payout payload (redacted/masked when returned to clients) */
  payload: Record<string, unknown>;
  /** Current status of the DLQ entry */
  status: PayoutDlqStatus;
  /** Number of delivery attempts before DLQ-ing */
  retries: number;
  /** ISO 8601 timestamp when the entry was created */
  createdAt: string;
  /** ISO 8601 timestamp when the entry was last updated */
  updatedAt: string;
}

/** Options for adding a new DLQ entry */
export interface AddPayoutDlqEntryInput {
  supplierId: string;
  errorClass: string;
  errorMessage: string;
  payload: Record<string, unknown>;
  retries?: number;
}

/** Options for listing DLQ entries */
export interface ListPayoutDlqOptions {
  supplierId?: string;
  errorClass?: string;
  status?: PayoutDlqStatus;
  search?: string;
  limit?: number;
  offset?: number;
}

/** Result of listing DLQ entries */
export interface ListPayoutDlqResult {
  entries: PayoutDlqEntry[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * In-memory store for payout dead-letter queue entries.
 *
 * Provides safe inspection capabilities with server-side PII masking
 * so operators can review failed payouts without exposing sensitive data.
 */
export class PayoutDlqStore {
  private readonly store = new Map<string, PayoutDlqEntry>();

  /**
   * Add a new DLQ entry.
   * @returns The created entry (with generated id and timestamps)
   */
  add(input: AddPayoutDlqEntryInput): PayoutDlqEntry {
    const id = uuidv4();
    const now = new Date().toISOString();
    const entry: PayoutDlqEntry = {
      id,
      supplierId: input.supplierId,
      errorClass: input.errorClass,
      errorMessage: input.errorMessage,
      payload: structuredClone(input.payload),
      status: "pending",
      retries: input.retries ?? 0,
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(id, entry);
    return this.cloneEntry(entry);
  }

  /**
   * Retrieve a single DLQ entry by ID.
   * The returned payload is masked to protect PII.
   * @returns The entry with masked payload, or undefined if not found
   */
  getById(id: string): MaskedPayoutDlqEntry | undefined {
    const entry = this.store.get(id);
    if (!entry) return undefined;
    return this.maskEntry(entry);
  }

  /**
   * Retrieve a raw DLQ entry by ID (internal use only, no masking).
   * @returns The raw entry, or undefined if not found
   */
  getByIdRaw(id: string): PayoutDlqEntry | undefined {
    const entry = this.store.get(id);
    return entry ? this.cloneEntry(entry) : undefined;
  }

  /**
   * List DLQ entries with optional filtering and pagination.
   * All returned entries have their payloads masked server-side.
   *
   * @param options - Filtering and pagination options
   * @returns Paginated list of masked entries with total count
   */
  list(options: ListPayoutDlqOptions = {}): ListPayoutDlqResult {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);

    let entries = Array.from(this.store.values());

    // Apply filters
    if (options.supplierId) {
      entries = entries.filter(
        (e) => e.supplierId === options.supplierId,
      );
    }
    if (options.errorClass) {
      entries = entries.filter(
        (e) =>
          e.errorClass.toLowerCase() === options.errorClass!.toLowerCase(),
      );
    }
    if (options.status) {
      entries = entries.filter((e) => e.status === options.status);
    }
    if (options.search) {
      const searchTerm = options.search.toLowerCase();
      entries = entries.filter(
        (e) =>
          e.supplierId.toLowerCase().includes(searchTerm) ||
          e.errorClass.toLowerCase().includes(searchTerm) ||
          e.errorMessage.toLowerCase().includes(searchTerm) ||
          e.id.toLowerCase().includes(searchTerm),
      );
    }

    // Sort by createdAt descending (newest first)
    entries.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    const total = entries.length;
    const paginated = entries.slice(offset, offset + limit);

    return {
      entries: paginated.map((e) => this.maskEntry(e)),
      total,
      limit,
      offset,
    };
  }

  /**
   * Mark a DLQ entry as "inspected" (for audit trail purposes).
   * @returns The updated entry, or undefined if not found
   */
  markInspected(id: string): PayoutDlqEntry | undefined {
    const entry = this.store.get(id);
    if (!entry) return undefined;
    entry.status = "inspected";
    entry.updatedAt = new Date().toISOString();
    this.store.set(id, entry);
    return this.cloneEntry(entry);
  }

  /**
   * Remove all entries from the store (useful for testing).
   */
  reset(): void {
    this.store.clear();
  }

  /**
   * Get the total number of entries (useful for metrics/testing).
   */
  get size(): number {
    return this.store.size;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Deep-clone an entry to prevent external mutation.
   */
  private cloneEntry(entry: PayoutDlqEntry): PayoutDlqEntry {
    return {
      ...entry,
      payload: structuredClone(entry.payload),
    };
  }

  /**
   * Apply server-side masking to an entry's payload to protect PII.
   * Uses the centralized redact utility for consistent masking.
   */
  private maskEntry(entry: PayoutDlqEntry): MaskedPayoutDlqEntry {
    return {
      id: entry.id,
      supplierId: entry.supplierId,
      errorClass: entry.errorClass,
      errorMessage: entry.errorMessage,
      payload: redact(entry.payload) as Record<string, unknown>,
      status: entry.status,
      retries: entry.retries,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }
}

/**
 * A DLQ entry with the payload masked for safe operator inspection.
 * Structurally identical to PayoutDlqEntry; the semantic distinction
 * indicates that the payload has been processed through the redaction pipeline.
 */
export type MaskedPayoutDlqEntry = PayoutDlqEntry;

/** Singleton instance for application-wide use */
let defaultStore: PayoutDlqStore | null = null;

/**
 * Get the default PayoutDlqStore singleton.
 * Creates one if it doesn't exist.
 */
export function getPayoutDlqStore(): PayoutDlqStore {
  if (!defaultStore) {
    defaultStore = new PayoutDlqStore();
  }
  return defaultStore;
}

/**
 * Reset the default singleton (useful for testing).
 */
export function resetPayoutDlqStore(): void {
  if (defaultStore) {
    defaultStore.reset();
  }
  defaultStore = null;
}
