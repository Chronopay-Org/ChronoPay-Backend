/**
 * Focused behaviour coverage for migration 019
 * (`src/db/migrations/019_add_active_booking_intent_unique_idx.ts`).
 *
 * Migration 019 is pure schema DDL with no data backfill:
 *
 *  - `up()` drops the over-broad `booking_intents_slot_id_key` UNIQUE constraint
 *    added in 004 and replaces it with a *partial* unique index scoped to the
 *    active statuses (`pending`, `hold_placed`).
 *  - `down()` reverses exactly that: it drops the partial index and restores the
 *    original full UNIQUE constraint.
 *
 * The tests below pin the emitted SQL, the statement ordering (a partial index
 * must never be created before the legacy constraint is dropped), the
 * schema-only/no-bound-parameter property, and the failure contract: a rejected
 * statement surfaces to `MigrationRunner` and the migration stops issuing DDL.
 *
 * The `pg` module is mapped to `test/mocks/pg.ts` by `jest.config.cjs`, so a
 * structural `{ query }` stub is all the migration needs.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";

import type { PoolClient } from "pg";
import { migration } from "../../db/migrations/019_add_active_booking_intent_unique_idx.js";

interface QueryCall {
  text: string;
  values?: unknown[];
}

/**
 * Build a mock `PoolClient` that records every statement and resolves with an
 * empty result set (DDL returns no rows).
 */
function createHarness() {
  const calls: QueryCall[] = [];
  const query = jest.fn(async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    return { rows: [] as unknown[] };
  });

  return { client: { query } as unknown as PoolClient, query, calls };
}

/** Collapse whitespace so assertions are insensitive to template indentation. */
function sql(call: QueryCall): string {
  return call.text.replace(/\s+/g, " ").trim();
}

const DROP_LEGACY_CONSTRAINT =
  /ALTER TABLE booking_intents DROP CONSTRAINT IF EXISTS booking_intents_slot_id_key/;
const CREATE_PARTIAL_INDEX =
  /CREATE UNIQUE INDEX idx_booking_intents_one_active_per_slot ON booking_intents \(slot_id\) WHERE status IN \('pending', 'hold_placed'\)/;
const DROP_PARTIAL_INDEX = /DROP INDEX IF EXISTS idx_booking_intents_one_active_per_slot/;
const RESTORE_LEGACY_CONSTRAINT =
  /ALTER TABLE booking_intents ADD CONSTRAINT booking_intents_slot_id_key UNIQUE \(slot_id\)/;

describe("migration 019 — add_active_booking_intent_unique_idx", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  describe("migration metadata", () => {
    it("keeps the registered id and name stable", () => {
      expect(migration.id).toBe("019");
      expect(migration.name).toBe("add_active_booking_intent_unique_idx");
    });

    it("exposes up() and down() as callable migration hooks", () => {
      expect(typeof migration.up).toBe("function");
      expect(typeof migration.down).toBe("function");
    });
  });

  describe("up()", () => {
    it("drops the legacy full UNIQUE constraint before creating the partial index", async () => {
      await migration.up(harness.client);

      expect(harness.calls).toHaveLength(2);
      expect(sql(harness.calls[0])).toMatch(DROP_LEGACY_CONSTRAINT);
      expect(sql(harness.calls[1])).toMatch(CREATE_PARTIAL_INDEX);
    });

    it("scopes the unique index to the active statuses only", async () => {
      await migration.up(harness.client);

      expect(harness.calls).toHaveLength(2);
      const ddl = sql(harness.calls[1]);

      // Only one in-flight intent per slot: terminal intents must not block a new one.
      expect(ddl).toContain("WHERE status IN ('pending', 'hold_placed')");
      expect(ddl).toContain("CREATE UNIQUE INDEX");
      expect(ddl).toContain("ON booking_intents (slot_id)");
    });

    it("is schema-only: no row reads/writes and no bound parameters", async () => {
      await migration.up(harness.client);

      for (const call of harness.calls) {
        expect(call.values).toBeUndefined();
        expect(sql(call)).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE)\b/);
      }
    });

    it("surfaces a rejected statement and stops before creating the index", async () => {
      const denied = Object.assign(new Error("permission denied for table booking_intents"), {
        code: "42501",
      });
      harness.query.mockRejectedValueOnce(denied as never);

      await expect(migration.up(harness.client)).rejects.toThrow("permission denied");

      // A partial index must never be created while the legacy constraint is still present.
      expect(harness.calls).toHaveLength(1);
      expect(sql(harness.calls[0])).toMatch(DROP_LEGACY_CONSTRAINT);
    });

    it("propagates the original driver error object unchanged", async () => {
      const deadlock = new Error("deadlock detected");
      harness.query.mockRejectedValueOnce(deadlock as never);

      await expect(migration.up(harness.client)).rejects.toBe(deadlock);
    });
  });

  describe("down()", () => {
    it("drops the partial index then restores the legacy constraint", async () => {
      await migration.down(harness.client);

      expect(harness.calls).toHaveLength(2);
      expect(sql(harness.calls[0])).toMatch(DROP_PARTIAL_INDEX);
      expect(sql(harness.calls[1])).toMatch(RESTORE_LEGACY_CONSTRAINT);
    });

    it("stops after a failed DROP so the legacy constraint is not restored early", async () => {
      harness.query.mockRejectedValueOnce(
        new Error("cannot drop index because it does not exist") as never,
      );

      await expect(migration.down(harness.client)).rejects.toThrow("cannot drop index");

      expect(harness.calls).toHaveLength(1);
      expect(sql(harness.calls[0])).toMatch(DROP_PARTIAL_INDEX);
    });

    it("propagates the original driver error object unchanged", async () => {
      const conflict = new Error("cannot ALTER TABLE because it has pending trigger events");
      harness.query.mockRejectedValueOnce(conflict as never);

      await expect(migration.down(harness.client)).rejects.toBe(conflict);
    });
  });

  describe("up()/down() round trip", () => {
    it("is an exact DDL inverse of itself", async () => {
      await migration.up(harness.client);
      expect(harness.calls).toHaveLength(2);
      const [dropLegacy, createIndex] = harness.calls.map(sql);

      harness.calls.length = 0;
      await migration.down(harness.client);
      expect(harness.calls).toHaveLength(2);
      const [dropIndex, addLegacy] = harness.calls.map(sql);

      // What up() removed is restored by down(); what up() created is removed by down().
      expect(dropLegacy).toMatch(DROP_LEGACY_CONSTRAINT);
      expect(addLegacy).toMatch(RESTORE_LEGACY_CONSTRAINT);
      expect(createIndex).toMatch(CREATE_PARTIAL_INDEX);
      expect(dropIndex).toMatch(DROP_PARTIAL_INDEX);
    });
  });
});
