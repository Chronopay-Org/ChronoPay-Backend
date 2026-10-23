/**
 * src/modules/cancellation/__tests__/pg-cancellation-reversal-repository.test.ts
 *
 * Regression suite for PgCancellationReversalRepository (QueryFn paths)
 * and InMemoryCancellationReversalRepository.
 *
 * Coverage targets:
 *   PgCancellationReversalRepository
 *     - insert  — happy path (returns mapped entry)
 *     - insert  — idempotency_key UNIQUE violation → CancellationReversalIdempotencyConflictError
 *     - insert  — entry_hash UNIQUE violation → CancellationReversalEntryHashCollisionError
 *     - insert  — other DB error is rethrown as-is
 *     - findByIdempotencyKey — found → returns entry
 *     - findByIdempotencyKey — NOT found (return null branch, line 246)
 *     - findByPaymentId — zero rows → empty array
 *     - findByPaymentId — multiple rows → mapped array
 *     - findByBookingIntentId — zero rows → empty array
 *     - findByBookingIntentId — multiple rows → mapped array
 *     - mapRow — NULL prev_hash → ""
 *     - mapRow — non-null prev_hash → propagated
 *     - mapRow — optional fields originalRefundId / escrowReleaseTxId absent
 *
 *   InMemoryCancellationReversalRepository
 *     - insert  — happy path
 *     - insert  — idempotency key collision → CancellationReversalIdempotencyConflictError
 *     - insert  — entry hash collision → CancellationReversalEntryHashCollisionError
 *     - findByIdempotencyKey — found / not found (return null branch)
 *     - findByPaymentId — empty / non-empty
 *     - findByBookingIntentId — empty / non-empty
 *     - _replace — found → returns merged entry
 *     - _replace — id absent → return null (line 284)
 *     - _replace — paymentId mutation rebuilds index
 *     - _replace — bookingIntentId mutation rebuilds index
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { QueryResult } from "pg";
import {
  PgCancellationReversalRepository,
  InMemoryCancellationReversalRepository,
  CancellationReversalEntryHashCollisionError,
  type QueryFn,
} from "../pg-cancellation-reversal-repository.js";
import { CancellationReversalIdempotencyConflictError } from "../cancellation-reversal-service.js";
import type { CancellationReversalEntry } from "../../../types/cancellationReversal.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_DATE = new Date("2026-01-15T12:00:00Z");

function makeEntry(
  overrides: Partial<CancellationReversalEntry> = {},
): CancellationReversalEntry {
  return {
    id: "entry-1",
    bookingIntentId: "intent-1",
    paymentId: "pay-1",
    amountCents: -1500,
    currency: "USD",
    escrowReleased: false,
    escrowReleasedAmountCents: 0,
    reason: "prorated_cancellation",
    idempotencyKey: "idem-key-1",
    policyVersionId: "v1",
    actor: "user-1",
    entryHash: "abc123",
    prevHash: "",
    createdAt: BASE_DATE,
    ...overrides,
  };
}

/** Build a minimal pg QueryResult wrapping the given rows. */
function makeQueryResult(rows: Record<string, unknown>[]): QueryResult {
  return {
    rows,
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
  };
}

/** Row shape returned by the DB (snake_case). */
function makeDbRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "entry-1",
    booking_intent_id: "intent-1",
    payment_id: "pay-1",
    original_refund_id: null,
    amount_cents: -1500,
    currency: "USD",
    escrow_released: false,
    escrow_released_amount_cents: 0,
    escrow_release_tx_id: null,
    reason: "prorated_cancellation",
    idempotency_key: "idem-key-1",
    policy_version_id: "v1",
    actor: "user-1",
    metadata: null,
    entry_hash: "abc123",
    prev_hash: null,
    created_at: BASE_DATE,
    ...overrides,
  };
}

/** Build a pg error object mimicking a 23505 UNIQUE violation. */
function makeUniqueViolation(constraint: string): unknown {
  return Object.assign(new Error("duplicate key value"), {
    code: "23505",
    constraint,
  });
}

// ─── PgCancellationReversalRepository ────────────────────────────────────────

describe("PgCancellationReversalRepository", () => {
  // ── insert ──────────────────────────────────────────────────────────────────

  describe("insert", () => {
    it("returns a mapped CancellationReversalEntry on success", async () => {
      const row = makeDbRow();
      const mockQuery = jest
        .fn<QueryFn>()
        .mockResolvedValueOnce(makeQueryResult([row]) as never);

      const repo = new PgCancellationReversalRepository(mockQuery as QueryFn);
      const result = await repo.insert(makeEntry());

      expect(result.id).toBe("entry-1");
      expect(result.paymentId).toBe("pay-1");
      expect(result.amountCents).toBe(-1500);
      expect(result.currency).toBe("USD");
      expect(result.prevHash).toBe(""); // NULL → ""
      expect(result.createdAt).toBeInstanceOf(Date);
    });

    it("passes prevHash='' as NULL to the database", async () => {
      const mockQuery = jest
        .fn<QueryFn>()
        .mockResolvedValueOnce(makeQueryResult([makeDbRow()]) as never);

      const repo = new PgCancellationReversalRepository(mockQuery as QueryFn);
      await repo.insert(makeEntry({ prevHash: "" }));

      const params = (mockQuery as jest.Mock).mock.calls[0][1] as unknown[];
      // prevHash is param index 14 (0-based)
      expect(params[14]).toBeNull();
    });

    it("passes a non-empty prevHash through to the database", async () => {
      const mockQuery = jest
        .fn<QueryFn>()
        .mockResolvedValueOnce(
          makeQueryResult([makeDbRow({ prev_hash: "prevhash999" })]) as never,
        );

      const repo = new PgCancellationReversalRepository(mockQuery as QueryFn);
      await repo.insert(makeEntry({ prevHash: "prevhash999" }));

      const params = (mockQuery as jest.Mock).mock.calls[0][1] as unknown[];
      expect(params[14]).toBe("prevhash999");
    });

    it("throws CancellationReversalIdempotencyConflictError on idempotency_key violation", async () => {
      const mockQuery = jest
        .fn<QueryFn>()
        .mockRejectedValueOnce(
          makeUniqueViolation("cancellation_reversal_entries_idempotency_key") as never,
        );

      const repo = new PgCancellationReversalRepository(mockQuery as QueryFn);
      await expect(repo.insert(makeEntry())).rejects.toBeInstanceOf(
        CancellationReversalIdempotencyConflictError,
      );
    });

    it("throws CancellationReversalEntryHashCollisionError on entry_hash violation", async () => {
      const mockQuery = jest
        .fn<QueryFn>()
        .mockRejectedValueOnce(
          makeUniqueViolation("cancellation_reversal_entries_entry_hash") as never,
        );

      const repo = new PgCancellationReversalRepository(mockQuery as QueryFn);
      await expect(repo.insert(makeEntry())).rejects.toBeInstanceOf(
        CancellationReversalEntryHashCollisionError,
      );
    });

    it("rethrows unrelated database errors unchanged", async () => {
      const dbError = Object.assign(new Error("connection refused"), {
        code: "08006",
      });
      const mockQuery = jest
        .fn<QueryFn>()
        .mockRejectedValueOnce(dbError as never);

      const repo = new PgCancellationReversalRepository(mockQuery as QueryFn);
      await expect(repo.insert(makeEntry())).rejects.toBe(dbError);
    });
  });

  // ── findByIdempotencyKey ─────────────────────────────────────────────────────

  describe("findByIdempotencyKey", () => {
    it("returns a mapped entry when the key exists", async () => {
      const row = makeDbRow({ idempotency_key: "idem-key-1" });
      const mockQuery = jest
        .fn<QueryFn>()
        .mockResolvedValueOnce(makeQueryResult([row]) as never);

      const repo = new PgCancellationReversalRepository(mockQuery as QueryFn);
      const result = await repo.findByIdempotencyKey("idem-key-1");

      expect(result).not.toBeNull();
      expect(result!.idempotencyKey).toBe("idem-key-1");
    });

    /**
     * Regression for the explicit `return null` branch at line 246.
     * When the DB returns zero rows, the repository must return null — not
     * throw and not return an undefined-shaped object.
     */
    it("returns null when the key is not found (empty result set)", async () => {
      const mockQuery = jest
        .fn<QueryFn>()
        .mockResolvedValueOnce(makeQueryResult([]) as never);

      const repo = new PgCancellationReversalRepository(mockQuery as QueryFn);
      const result = await repo.findByIdempotencyKey("nonexistent-key");

      expect(result).toBeNull();
    });
  });

  // ── findByPaymentId ──────────────────────────────────────────────────────────

  describe("findByPaymentId", () => {
    it("returns an empty array when no rows match", async () => {
      const mockQuery = jest
        .fn<QueryFn>()
        .mockResolvedValueOnce(makeQueryResult([]) as never);

      const repo = new PgCancellationReversalRepository(mockQuery as QueryFn);
      const result = await repo.findByPaymentId("pay-unknown");

      expect(result).toEqual([]);
    });

    it("returns all rows mapped to CancellationReversalEntry", async () => {
      const rows = [
        makeDbRow({ id: "entry-1", idempotency_key: "idem-1" }),
        makeDbRow({ id: "entry-2", idempotency_key: "idem-2" }),
      ];
      const mockQuery = jest
        .fn<QueryFn>()
        .mockResolvedValueOnce(makeQueryResult(rows) as never);

      const repo = new PgCancellationReversalRepository(mockQuery as QueryFn);
      const result = await repo.findByPaymentId("pay-1");

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("entry-1");
      expect(result[1].id).toBe("entry-2");
    });
  });

  // ── findByBookingIntentId ────────────────────────────────────────────────────

  describe("findByBookingIntentId", () => {
    it("returns an empty array when no rows match", async () => {
      const mockQuery = jest
        .fn<QueryFn>()
        .mockResolvedValueOnce(makeQueryResult([]) as never);

      const repo = new PgCancellationReversalRepository(mockQuery as QueryFn);
      const result = await repo.findByBookingIntentId("intent-unknown");

      expect(result).toEqual([]);
    });

    it("returns all rows mapped to CancellationReversalEntry", async () => {
      const rows = [
        makeDbRow({ id: "e1", booking_intent_id: "intent-99" }),
        makeDbRow({ id: "e2", booking_intent_id: "intent-99" }),
      ];
      const mockQuery = jest
        .fn<QueryFn>()
        .mockResolvedValueOnce(makeQueryResult(rows) as never);

      const repo = new PgCancellationReversalRepository(mockQuery as QueryFn);
      const result = await repo.findByBookingIntentId("intent-99");

      expect(result).toHaveLength(2);
      expect(result[0].bookingIntentId).toBe("intent-99");
    });
  });

  // ── mapRow edge cases ────────────────────────────────────────────────────────

  describe("mapRow (via insert)", () => {
    it("maps prev_hash=null to prevHash=''", async () => {
      const row = makeDbRow({ prev_hash: null });
      const mockQuery = jest
        .fn<QueryFn>()
        .mockResolvedValueOnce(makeQueryResult([row]) as never);

      const repo = new PgCancellationReversalRepository(mockQuery as QueryFn);
      const result = await repo.insert(makeEntry());

      expect(result.prevHash).toBe("");
    });

    it("maps prev_hash='somehash' to prevHash='somehash'", async () => {
      const row = makeDbRow({ prev_hash: "somehash" });
      const mockQuery = jest
        .fn<QueryFn>()
        .mockResolvedValueOnce(makeQueryResult([row]) as never);

      const repo = new PgCancellationReversalRepository(mockQuery as QueryFn);
      const result = await repo.insert(makeEntry());

      expect(result.prevHash).toBe("somehash");
    });

    it("maps original_refund_id=null to originalRefundId=undefined", async () => {
      const row = makeDbRow({ original_refund_id: null });
      const mockQuery = jest
        .fn<QueryFn>()
        .mockResolvedValueOnce(makeQueryResult([row]) as never);

      const repo = new PgCancellationReversalRepository(mockQuery as QueryFn);
      const result = await repo.insert(makeEntry());

      expect(result.originalRefundId).toBeUndefined();
    });

    it("maps original_refund_id to the string value when present", async () => {
      const row = makeDbRow({ original_refund_id: "refund-42" });
      const mockQuery = jest
        .fn<QueryFn>()
        .mockResolvedValueOnce(makeQueryResult([row]) as never);

      const repo = new PgCancellationReversalRepository(mockQuery as QueryFn);
      const result = await repo.insert(makeEntry());

      expect(result.originalRefundId).toBe("refund-42");
    });

    it("maps escrow_release_tx_id=null to escrowReleaseTxId=undefined", async () => {
      const row = makeDbRow({ escrow_release_tx_id: null });
      const mockQuery = jest
        .fn<QueryFn>()
        .mockResolvedValueOnce(makeQueryResult([row]) as never);

      const repo = new PgCancellationReversalRepository(mockQuery as QueryFn);
      const result = await repo.insert(makeEntry());

      expect(result.escrowReleaseTxId).toBeUndefined();
    });

    it("parses created_at string into a Date instance", async () => {
      const row = makeDbRow({ created_at: "2025-06-01T00:00:00.000Z" });
      const mockQuery = jest
        .fn<QueryFn>()
        .mockResolvedValueOnce(makeQueryResult([row]) as never);

      const repo = new PgCancellationReversalRepository(mockQuery as QueryFn);
      const result = await repo.insert(makeEntry());

      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.createdAt.toISOString()).toBe("2025-06-01T00:00:00.000Z");
    });
  });
});

// ─── InMemoryCancellationReversalRepository ───────────────────────────────────

describe("InMemoryCancellationReversalRepository", () => {
  let repo: InMemoryCancellationReversalRepository;

  beforeEach(() => {
    repo = new InMemoryCancellationReversalRepository();
  });

  // ── insert ───────────────────────────────────────────────────────────────────

  describe("insert", () => {
    it("stores and returns a clone of the entry", async () => {
      const entry = makeEntry();
      const result = await repo.insert(entry);

      expect(result.id).toBe(entry.id);
      expect(result).not.toBe(entry); // must be a clone
    });

    it("throws CancellationReversalIdempotencyConflictError on duplicate idempotencyKey", async () => {
      await repo.insert(makeEntry({ idempotencyKey: "same-key" }));
      await expect(
        repo.insert(makeEntry({ id: "entry-2", entryHash: "different-hash", idempotencyKey: "same-key" })),
      ).rejects.toBeInstanceOf(CancellationReversalIdempotencyConflictError);
    });

    it("throws CancellationReversalEntryHashCollisionError on duplicate entryHash", async () => {
      await repo.insert(makeEntry({ entryHash: "same-hash" }));
      await expect(
        repo.insert(makeEntry({ id: "entry-2", idempotencyKey: "different-key", entryHash: "same-hash" })),
      ).rejects.toBeInstanceOf(CancellationReversalEntryHashCollisionError);
    });
  });

  // ── findByIdempotencyKey ─────────────────────────────────────────────────────

  describe("findByIdempotencyKey", () => {
    it("returns the matching entry when it exists", async () => {
      await repo.insert(makeEntry({ idempotencyKey: "key-A" }));
      const result = await repo.findByIdempotencyKey("key-A");
      expect(result).not.toBeNull();
      expect(result!.idempotencyKey).toBe("key-A");
    });

    /**
     * Regression for the explicit `return null` at line 246:
     * when no entry with that key is stored, findByIdempotencyKey MUST
     * return null (not throw, not return undefined).
     */
    it("returns null when no entry matches the key", async () => {
      const result = await repo.findByIdempotencyKey("nonexistent");
      expect(result).toBeNull();
    });

    it("returns a defensive clone, not the internal reference", async () => {
      const original = makeEntry({ idempotencyKey: "key-B" });
      await repo.insert(original);
      const result = await repo.findByIdempotencyKey("key-B");
      expect(result).not.toBe(original);
    });
  });

  // ── findByPaymentId ──────────────────────────────────────────────────────────

  describe("findByPaymentId", () => {
    it("returns an empty array when no entries match", async () => {
      const result = await repo.findByPaymentId("pay-unknown");
      expect(result).toEqual([]);
    });

    it("returns all entries for the given paymentId", async () => {
      await repo.insert(makeEntry({ id: "e1", idempotencyKey: "k1", entryHash: "h1", paymentId: "pay-X" }));
      await repo.insert(makeEntry({ id: "e2", idempotencyKey: "k2", entryHash: "h2", paymentId: "pay-X" }));
      await repo.insert(makeEntry({ id: "e3", idempotencyKey: "k3", entryHash: "h3", paymentId: "pay-Y" }));

      const result = await repo.findByPaymentId("pay-X");
      expect(result).toHaveLength(2);
      expect(result.map((e) => e.id).sort()).toEqual(["e1", "e2"]);
    });
  });

  // ── findByBookingIntentId ────────────────────────────────────────────────────

  describe("findByBookingIntentId", () => {
    it("returns an empty array when no entries match", async () => {
      const result = await repo.findByBookingIntentId("intent-unknown");
      expect(result).toEqual([]);
    });

    it("returns all entries for the given bookingIntentId", async () => {
      await repo.insert(makeEntry({ id: "e1", idempotencyKey: "k1", entryHash: "h1", bookingIntentId: "bi-1" }));
      await repo.insert(makeEntry({ id: "e2", idempotencyKey: "k2", entryHash: "h2", bookingIntentId: "bi-1" }));

      const result = await repo.findByBookingIntentId("bi-1");
      expect(result).toHaveLength(2);
    });
  });

  // ── _replace ─────────────────────────────────────────────────────────────────

  describe("_replace", () => {
    it("returns the merged entry when the id exists", async () => {
      await repo.insert(makeEntry({ id: "e1" }));
      const updated = await repo._replace("e1", { amountCents: -9999 });

      expect(updated).not.toBeNull();
      expect(updated!.amountCents).toBe(-9999);
      expect(updated!.id).toBe("e1");
    });

    /**
     * Regression for `if (!existing) return null` at line 284:
     * when the id is not in the store, _replace MUST return null.
     */
    it("returns null when the id is not present in the store", async () => {
      const result = await repo._replace("nonexistent-id", { amountCents: -100 });
      expect(result).toBeNull();
    });

    it("rebuilds the paymentId index when paymentId changes", async () => {
      await repo.insert(makeEntry({ id: "e1", paymentId: "pay-OLD" }));
      await repo._replace("e1", { paymentId: "pay-NEW" });

      const fromOld = await repo.findByPaymentId("pay-OLD");
      const fromNew = await repo.findByPaymentId("pay-NEW");

      expect(fromOld).toHaveLength(0);
      expect(fromNew).toHaveLength(1);
      expect(fromNew[0].id).toBe("e1");
    });

    it("rebuilds the bookingIntentId index when bookingIntentId changes", async () => {
      await repo.insert(makeEntry({ id: "e1", bookingIntentId: "bi-OLD" }));
      await repo._replace("e1", { bookingIntentId: "bi-NEW" });

      const fromOld = await repo.findByBookingIntentId("bi-OLD");
      const fromNew = await repo.findByBookingIntentId("bi-NEW");

      expect(fromOld).toHaveLength(0);
      expect(fromNew).toHaveLength(1);
    });

    it("accepts a Date override for createdAt", async () => {
      await repo.insert(makeEntry({ id: "e1" }));
      const newDate = new Date("2030-01-01T00:00:00Z");
      const updated = await repo._replace("e1", { createdAt: newDate });

      expect(updated!.createdAt.toISOString()).toBe("2030-01-01T00:00:00.000Z");
    });
  });
});
