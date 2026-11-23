/**
 * src/modules/cancellation/pg-cancellation-reversal-repository.ts
 *
 * PostgreSQL repository for `cancellation_reversal_entries`. Mirrors
 * the conventions used by `pg-refund-repository.ts`:
 *
 *   - Default constructor uses the singleton pool's `query` wrapper.
 *   - `dbQuery` can be replaced with `jest.fn()` in tests.
 *   - `prev_hash = ""` is persisted as NULL and vice-versa on read.
 *   - `idempotencyKey` UNIQUE is enforced by both the schema and the
 *     repository: a duplicate raises
 *     `CancellationReversalIdempotencyConflictError` so the service
 *     can short-circuit.
 *
 * Also exports `InMemoryCancellationReversalRepository` (with `_replace`
 * test helper) for service-level tests that exercise the service
 * without spinning up a real database.
 */

import type { QueryResult } from "pg";
import { query as defaultQuery } from "../../db/pool.js";
import type { CancellationReversalEntry } from "../../types/cancellationReversal.js";
import {
  CancellationReversalIdempotencyConflictError,
  type CancellationReversalRepository,
} from "./cancellation-reversal-service.js";

/**
 * The query-helper signature accepted by `PgCancellationReversalRepository`.
 * Exported so test files can `jest.fn().mockRejectedValueOnce(...)` and
 * cast the mock through `QueryFn` without `as unknown as never`.
 */
export type QueryFn = (
  text: string,
  params?: unknown[],
) => Promise<QueryResult>;

export class PgCancellationReversalRepository
  implements CancellationReversalRepository
{
  constructor(private readonly dbQuery: QueryFn = defaultQuery) {}

  async insert(
    input: CancellationReversalEntry,
  ): Promise<CancellationReversalEntry> {
    const sql = `
      INSERT INTO cancellation_reversal_entries
        (booking_intent_id, payment_id, original_refund_id,
         amount_cents, currency, escrow_released,
         escrow_released_amount_cents, escrow_release_tx_id,
         reason, idempotency_key, policy_version_id, actor,
         metadata, entry_hash, prev_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `;

    try {
      const res = await this.dbQuery(sql, [
        input.bookingIntentId,
        input.paymentId,
        input.originalRefundId ?? null,
        input.amountCents,
        input.currency,
        input.escrowReleased,
        input.escrowReleasedAmountCents,
        input.escrowReleaseTxId ?? null,
        input.reason,
        input.idempotencyKey,
        input.policyVersionId,
        input.actor,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.entryHash,
        input.prevHash === "" ? null : input.prevHash,
      ]);
      return mapRow(res.rows[0]);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        // The DB enforces UNIQUE on idempotency_key and entry_hash.
        // Distinguish the two by inspecting the constraint name.
        const constraint = String(
          (err as { constraint?: string }).constraint ?? "",
        );
        if (
          constraint === "idempotency_key" ||
          constraint.includes("idempotency_key") ||
          constraint.includes("cancellation_reversal_entries_idempotency_key")
        ) {
          throw new CancellationReversalIdempotencyConflictError(
            input.idempotencyKey,
          );
        }
        if (
          constraint === "entry_hash" ||
          constraint.includes("entry_hash") ||
          constraint.includes("cancellation_reversal_entries_entry_hash")
        ) {
          throw new CancellationReversalEntryHashCollisionError(
            input.entryHash,
          );
        }
        throw err;
      }
      throw err;
    }
  }

  async findByIdempotencyKey(
    key: string,
  ): Promise<CancellationReversalEntry | null> {
    const res = await this.dbQuery(
      `SELECT * FROM cancellation_reversal_entries
       WHERE idempotency_key = $1
       LIMIT 1`,
      [key],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async findByPaymentId(
    paymentId: string,
  ): Promise<CancellationReversalEntry[]> {
    const res = await this.dbQuery(
      `SELECT * FROM cancellation_reversal_entries
       WHERE payment_id = $1
       ORDER BY created_at ASC, id ASC`,
      [paymentId],
    );
    return res.rows.map(mapRow);
  }

  async findByBookingIntentId(
    bookingIntentId: string,
  ): Promise<CancellationReversalEntry[]> {
    const res = await this.dbQuery(
      `SELECT * FROM cancellation_reversal_entries
       WHERE booking_intent_id = $1
       ORDER BY created_at ASC, id ASC`,
      [bookingIntentId],
    );
    return res.rows.map(mapRow);
  }
}

export class CancellationReversalEntryHashCollisionError extends Error {
  constructor(hash: string) {
    super(`Reversal entry hash collision: ${hash}`);
    this.name = "CancellationReversalEntryHashCollisionError";
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  return code === "23505";
}

function mapRow(row: Record<string, unknown>): CancellationReversalEntry {
  const createdAtRaw = row.created_at;
  const createdAt =
    createdAtRaw instanceof Date
      ? createdAtRaw
      : new Date(String(createdAtRaw));

  return {
    id: String(row.id ?? ""),
    bookingIntentId: String(row.booking_intent_id ?? ""),
    paymentId: String(row.payment_id ?? ""),
    originalRefundId:
      row.original_refund_id === null || row.original_refund_id === undefined
        ? undefined
        : String(row.original_refund_id),
    amountCents: Number(row.amount_cents ?? 0),
    currency: String(row.currency ?? "USD") as CancellationReversalEntry["currency"],
    escrowReleased: Boolean(row.escrow_released),
    escrowReleasedAmountCents: Number(row.escrow_released_amount_cents ?? 0),
    escrowReleaseTxId:
      row.escrow_release_tx_id === null || row.escrow_release_tx_id === undefined
        ? undefined
        : String(row.escrow_release_tx_id),
    reason: String(row.reason ?? ""),
    idempotencyKey: String(row.idempotency_key ?? ""),
    policyVersionId: String(row.policy_version_id ?? ""),
    actor: String(row.actor ?? ""),
    metadata:
      row.metadata === null || row.metadata === undefined
        ? undefined
        : (row.metadata as Record<string, unknown>),
    entryHash: String(row.entry_hash ?? ""),
    prevHash:
      row.prev_hash === null || row.prev_hash === undefined
        ? ""
        : String(row.prev_hash),
    createdAt,
  };
}

// ─── In-memory implementation (used by service tests) ────────────────────────

/**
 * Lightweight in-memory repository for testing the service without a
 * real database. Mirrors the PG UNIQUE constraints on `idempotency_key`
 * and `entry_hash` so service-level tests catch the same conflict
 * behaviour.
 */
export class InMemoryCancellationReversalRepository
  implements CancellationReversalRepository
{
  private readonly byId = new Map<string, CancellationReversalEntry>();
  private readonly byPayment = new Map<string, string[]>();
  private readonly byBooking = new Map<string, string[]>();

  async insert(
    input: CancellationReversalEntry,
  ): Promise<CancellationReversalEntry> {
    for (const e of this.byId.values()) {
      if (e.idempotencyKey === input.idempotencyKey) {
        throw new CancellationReversalIdempotencyConflictError(
          input.idempotencyKey,
        );
      }
      if (e.entryHash === input.entryHash) {
        throw new CancellationReversalEntryHashCollisionError(
          input.entryHash,
        );
      }
    }
    // Defensive clone so test mutations don't bleed into stored entries.
    const stored: CancellationReversalEntry = {
      ...input,
      createdAt: new Date(input.createdAt),
    };
    this.byId.set(stored.id, stored);
    this.appendIntoIndex(this.byPayment, stored.paymentId, stored.id);
    this.appendIntoIndex(this.byBooking, stored.bookingIntentId, stored.id);
    return { ...stored, createdAt: new Date(stored.createdAt) };
  }

  async findByIdempotencyKey(
    key: string,
  ): Promise<CancellationReversalEntry | null> {
    for (const e of this.byId.values()) {
      if (e.idempotencyKey === key) {
        return { ...e, createdAt: new Date(e.createdAt) };
      }
    }
    return null;
  }

  async findByPaymentId(
    paymentId: string,
  ): Promise<CancellationReversalEntry[]> {
    const ids = this.byPayment.get(paymentId) ?? [];
    return ids
      .map((id) => this.byId.get(id))
      .filter((e): e is CancellationReversalEntry => Boolean(e))
      .map((e) => ({ ...e, createdAt: new Date(e.createdAt) }));
  }

  async findByBookingIntentId(
    bookingIntentId: string,
  ): Promise<CancellationReversalEntry[]> {
    const ids = this.byBooking.get(bookingIntentId) ?? [];
    return ids
      .map((id) => this.byId.get(id))
      .filter((e): e is CancellationReversalEntry => Boolean(e))
      .map((e) => ({ ...e, createdAt: new Date(e.createdAt) }));
  }

  /**
   * Test helper — replace specific fields on a stored entry. Returns
   * the updated entry, or `null` if the id isn't present. Used by
   * tests to simulate row corruption (tampered `entryHash` /
   * `prevHash`) without breaking the abstraction.
   *
   * If `paymentId` or `bookingIntentId` are mutated, the by-payment
   * and by-booking indexes are rebuilt to keep invariant lookups
   * consistent.
   */
  async _replace(
    id: string,
    partial: Partial<CancellationReversalEntry>,
  ): Promise<CancellationReversalEntry | null> {
    const existing = this.byId.get(id);
    if (!existing) return null;
    const merged: CancellationReversalEntry = {
      ...existing,
      ...partial,
      createdAt: partial.createdAt
        ? partial.createdAt instanceof Date
          ? partial.createdAt
          : new Date(partial.createdAt)
        : existing.createdAt,
    };
    this.byId.set(id, merged);

    // Rebuild index memberships when key fields change.
    if (partial.paymentId && partial.paymentId !== existing.paymentId) {
      this.removeFromIndex(this.byPayment, existing.paymentId, id);
      this.appendIntoIndex(this.byPayment, partial.paymentId, id);
    }
    if (
      partial.bookingIntentId &&
      partial.bookingIntentId !== existing.bookingIntentId
    ) {
      this.removeFromIndex(this.byBooking, existing.bookingIntentId, id);
      this.appendIntoIndex(this.byBooking, partial.bookingIntentId, id);
    }

    return { ...merged, createdAt: new Date(merged.createdAt) };
  }

  private removeFromIndex(
    index: Map<string, string[]>,
    key: string,
    id: string,
  ): void {
    const cur = index.get(key) ?? [];
    const filtered = cur.filter((candidate) => candidate !== id);
    if (filtered.length === 0) {
      index.delete(key);
    } else {
      index.set(key, filtered);
    }
  }

  private appendIntoIndex(
    index: Map<string, string[]>,
    key: string,
    id: string,
  ): void {
    const cur = index.get(key) ?? [];
    cur.push(id);
    index.set(key, cur);
  }
}
