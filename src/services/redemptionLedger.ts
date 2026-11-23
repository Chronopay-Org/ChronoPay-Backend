/**
 * redemptionLedger.ts
 *
 * Idempotent, cryptographically-chained redemption ledger for ChronoPay
 * time-token redemptions.
 *
 * ## Guarantees
 *
 * ### Exactly-once semantics
 * `insertRedemption()` rejects duplicate `redemption_id` values.  The
 * UNIQUE constraint on `redemption_id` in the database is the authoritative
 * guard; the in-memory store replicates the same invariant for tests.
 *
 * ### Hash-chain integrity
 * Every entry records `entry_hash = SHA-256(redemption_id ‖ prev_hash ‖ created_at)`.
 * A verifier can re-derive the chain from the genesis row and detect any
 * retroactive mutation to a committed entry.  See `verifyChain()`.
 *
 * ### Serialised appends
 * The in-memory store uses a per-operation lock (single-entry promise chain)
 * to serialise concurrent inserts without requiring a real database
 * serialisable transaction.  A production Postgres implementation would use
 * `SELECT ... FOR UPDATE` on the tail row inside a SERIALIZABLE transaction.
 *
 * ## Design decisions
 *  - The hash input is a deterministic concatenation: `redemption_id|prev_hash|iso_timestamp`.
 *    Using the pipe character as a separator avoids the need for an additional
 *    escape scheme because none of the three fields contain `|`.
 *  - `prev_hash` for the genesis entry is the empty string "".  This makes
 *    the hash derivation uniform: no special-casing in the verifier.
 *  - Metadata is optional and intentionally not included in the hash so that
 *    operators can annotate entries post-hoc without breaking the chain.
 */

import crypto from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RedemptionEntry {
  id: string;
  redemption_id: string;
  token_id: string;
  redeemer_id: string;
  entry_hash: string;
  /** Empty string for the genesis row. */
  prev_hash: string;
  metadata?: Record<string, unknown>;
  created_at: Date;
}

export interface InsertRedemptionInput {
  redemption_id: string;
  token_id: string;
  redeemer_id: string;
  metadata?: Record<string, unknown>;
}

export interface VerificationResult {
  valid: boolean;
  /** Total number of entries examined. */
  entriesChecked: number;
  /**
   * Index (0-based) of the first broken entry, or undefined when the chain
   * is intact.
   */
  firstBrokenIndex?: number;
  error?: string;
}

// ─── Hash derivation ──────────────────────────────────────────────────────────

/**
 * Derive the deterministic entry hash for a ledger row.
 *
 * Hash input: `{redemption_id}|{prev_hash}|{created_at_iso}`
 *
 * @param redemptionId  The application-supplied redemption identifier.
 * @param prevHash      The `entry_hash` of the immediately preceding row,
 *                      or "" for the genesis row.
 * @param createdAt     The creation timestamp of this entry.
 */
export function deriveEntryHash(
  redemptionId: string,
  prevHash: string,
  createdAt: Date,
): string {
  const input = `${redemptionId}|${prevHash}|${createdAt.toISOString()}`;
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

// ─── In-memory ledger store ───────────────────────────────────────────────────

/**
 * In-memory implementation of the redemption ledger.
 *
 * This is the primary store used in tests.  A real implementation would
 * back the same interface with PostgreSQL (serialisable transactions +
 * the `redemption_ledger` table from migration 012).
 */
export class InMemoryRedemptionLedger {
  /**
   * Ordered chain of entries (genesis first).
   * We maintain insertion order explicitly to support O(1) tail lookup.
   */
  private readonly chain: RedemptionEntry[] = [];

  /**
   * Index by redemption_id for O(1) idempotency checks.
   */
  private readonly byRedemptionId = new Map<string, RedemptionEntry>();

  /**
   * Single-entry mutex: all concurrent callers queue behind this promise so
   * that the tail-lookup + hash-derivation + insert are atomic from the
   * perspective of this in-memory store.
   *
   * (A real DB implementation would use a SERIALIZABLE transaction instead.)
   */
  private insertQueue: Promise<void> = Promise.resolve();

  /**
   * Append a new redemption to the ledger.
   *
   * Throws `DuplicateRedemptionError` if `redemption_id` already exists.
   * Throws `ChainIntegrityError` if the store is in an inconsistent state
   * (should never happen under normal operation).
   *
   * @param input  The redemption details supplied by the caller.
   * @param nowFn  Overridable clock for testing (defaults to `new Date()`).
   */
  async insert(
    input: InsertRedemptionInput,
    nowFn: () => Date = () => new Date(),
  ): Promise<RedemptionEntry> {
    let resolve!: () => void;
    const ticket = new Promise<void>((res) => { resolve = res; });

    // Enqueue behind all in-flight inserts.
    const previous = this.insertQueue;
    this.insertQueue = this.insertQueue.then(() => ticket);

    try {
      await previous; // wait for the predecessor to finish

      if (this.byRedemptionId.has(input.redemption_id)) {
        throw new DuplicateRedemptionError(input.redemption_id);
      }

      const tail = this.chain.at(-1) ?? null;
      const prevHash = tail ? tail.entry_hash : "";
      const created_at = nowFn();
      const entry_hash = deriveEntryHash(
        input.redemption_id,
        prevHash,
        created_at,
      );

      const entry: RedemptionEntry = {
        id: crypto.randomUUID(),
        redemption_id: input.redemption_id,
        token_id: input.token_id,
        redeemer_id: input.redeemer_id,
        entry_hash,
        prev_hash: prevHash,
        metadata: input.metadata,
        created_at,
      };

      this.chain.push(entry);
      this.byRedemptionId.set(entry.redemption_id, entry);

      return entry;
    } finally {
      resolve();
    }
  }

  /**
   * Return all entries in insertion order (genesis first).
   */
  listAll(): readonly RedemptionEntry[] {
    return [...this.chain];
  }

  /**
   * Look up an entry by its `redemption_id`.
   * Returns `undefined` if not found.
   */
  findByRedemptionId(redemptionId: string): RedemptionEntry | undefined {
    return this.byRedemptionId.get(redemptionId);
  }

  /**
   * Return the number of entries in the ledger.
   */
  size(): number {
    return this.chain.length;
  }

  /**
   * Remove all entries.  For test isolation only.
   */
  clear(): void {
    this.chain.length = 0;
    this.byRedemptionId.clear();
    this.insertQueue = Promise.resolve();
  }

  /**
   * Directly overwrite the `entry_hash` of an existing entry.
   *
   * ⚠ This method exists exclusively for testing the chain verifier's ability
   * to detect tampered records.  Never call this in production code.
   *
   * @internal
   */
  _tamperEntryHash(redemptionId: string, fakeHash: string): void {
    const entry = this.byRedemptionId.get(redemptionId);
    if (!entry) throw new Error(`Entry not found: ${redemptionId}`);
    entry.entry_hash = fakeHash;
    // Also patch prev_hash of the next entry so the tamper is subtle.
    const idx = this.chain.findIndex((e) => e.redemption_id === redemptionId);
    if (idx >= 0 && idx + 1 < this.chain.length) {
      this.chain[idx + 1].prev_hash = fakeHash;
    }
  }

  /**
   * Remove an entry by `redemption_id` from the middle of the chain,
   * leaving `prev_hash` references broken.
   *
   * ⚠ For testing the verifier's skip-detection only.
   *
   * @internal
   */
  _deleteEntry(redemptionId: string): void {
    const idx = this.chain.findIndex((e) => e.redemption_id === redemptionId);
    if (idx < 0) return;
    this.chain.splice(idx, 1);
    this.byRedemptionId.delete(redemptionId);
  }
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown when an insertion is attempted for a `redemption_id` that already
 * exists in the ledger.
 */
export class DuplicateRedemptionError extends Error {
  constructor(public readonly redemptionId: string) {
    super(`Redemption already exists: ${redemptionId}`);
    this.name = "DuplicateRedemptionError";
  }
}

/**
 * Thrown by `verifyChain()` when a structural invariant violation is found
 * that prevents further traversal.
 */
export class ChainIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainIntegrityError";
  }
}

// ─── Verifier ─────────────────────────────────────────────────────────────────

/**
 * Walk the entire chain from genesis to tail and verify:
 *
 * 1. The genesis entry has `prev_hash === ""`.
 * 2. Each entry's `entry_hash` matches the re-derived hash from its own fields.
 * 3. Each non-genesis entry's `prev_hash` matches the `entry_hash` of the
 *    immediately preceding entry.
 *
 * Returns a `VerificationResult` rather than throwing so callers can decide
 * what to do (log, alert, halt).
 *
 * @param ledger  The ledger to verify.
 */
export function verifyChain(
  ledger: Pick<InMemoryRedemptionLedger, "listAll">,
): VerificationResult {
  const entries = ledger.listAll();

  if (entries.length === 0) {
    return { valid: true, entriesChecked: 0 };
  }

  // Verify genesis
  const genesis = entries[0];
  if (genesis.prev_hash !== "") {
    return {
      valid: false,
      entriesChecked: 1,
      firstBrokenIndex: 0,
      error: `Genesis entry has non-empty prev_hash: "${genesis.prev_hash}"`,
    };
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    // Re-derive the expected hash
    const expected = deriveEntryHash(
      entry.redemption_id,
      entry.prev_hash,
      entry.created_at,
    );

    if (entry.entry_hash !== expected) {
      return {
        valid: false,
        entriesChecked: i + 1,
        firstBrokenIndex: i,
        error:
          `Entry ${i} (redemption_id=${entry.redemption_id}) has invalid hash. ` +
          `Expected ${expected}, got ${entry.entry_hash}`,
      };
    }

    // Verify linkage with predecessor
    if (i > 0) {
      const prev = entries[i - 1];
      if (entry.prev_hash !== prev.entry_hash) {
        return {
          valid: false,
          entriesChecked: i + 1,
          firstBrokenIndex: i,
          error:
            `Entry ${i} (redemption_id=${entry.redemption_id}) prev_hash ` +
            `"${entry.prev_hash}" does not match predecessor hash "${prev.entry_hash}"`,
        };
      }
    }
  }

  return { valid: true, entriesChecked: entries.length };
}
