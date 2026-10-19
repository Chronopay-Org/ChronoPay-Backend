/**
 * Focused behavior tests for migration 005
 * — add_token_references_to_booking_intents.
 *
 * The migration's public contract is deliberately narrow: given a
 * `PoolClient`, `up()` must add the two token-reference columns and their
 * lookup index, while `down()` must remove the columns idempotently. These
 * tests pin the exact DDL, the statement ordering, error propagation, and
 * the up→down state transition so a regression in the SQL cannot slip
 * through unnoticed.
 *
 * The suite is hermetic — it injects a fake `PoolClient` that records every
 * `query()` call and never touches a real database. This keeps it fast and
 * deterministic in unit CI, while still exercising the full body of both
 * migration functions.
 */

import { describe, it, expect, jest } from "@jest/globals";
import type { PoolClient } from "pg";
import { migration } from "../005_add_token_references_to_booking_intents.js";

// ─── Test helpers ────────────────────────────────────────────────────────────

interface RecordedQuery {
  text: string;
  values?: unknown[];
}

/** Collapse SQL whitespace so assertions read like the intended DDL. */
function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * Build a fake `PoolClient` whose `query()` records each statement.
 *
 * `impl` lets a test force a failure (throw/reject) or otherwise shape the
 * result, simulating a database error for a specific statement.
 */
function makeClient(impl?: (text: string, values?: unknown[]) => Promise<unknown> | unknown): {
  client: PoolClient;
  calls: RecordedQuery[];
  query: jest.Mock;
} {
  const calls: RecordedQuery[] = [];
  const query = jest.fn(async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    if (impl) {
      return impl(text, values);
    }
    return { rows: [], rowCount: 0 };
  });

  const client = {
    query,
    release: jest.fn(),
  } as unknown as PoolClient;

  return { client, calls, query };
}

// ─── Migration metadata ──────────────────────────────────────────────────────

describe("migration 005 — add_token_references_to_booking_intents", () => {
  it("exposes a stable id and name for the migration registry", () => {
    expect(migration.id).toBe("005");
    expect(migration.name).toBe("add_token_references_to_booking_intents");
  });

  it("implements both up and down as functions", () => {
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  // ─── up(): forward migration ───────────────────────────────────────────────

  describe("up()", () => {
    it("adds both token reference columns to booking_intents", async () => {
      const { client, calls } = makeClient();

      await migration.up(client);

      expect(calls).toHaveLength(2);
      expect(normalize(calls[0].text)).toMatch(
        /^ALTER TABLE booking_intents ADD COLUMN token_asset TEXT, ADD COLUMN mint_tx_hash TEXT$/,
      );
    });

    it("creates a lookup index on the token_asset column", async () => {
      const { client, calls } = makeClient();

      await migration.up(client);

      expect(normalize(calls[1].text)).toMatch(
        /^CREATE INDEX idx_booking_intents_token_asset ON booking_intents \(token_asset\)$/,
      );
    });

    it("applies the ALTER before the index so column creation cannot race the index", async () => {
      const { client, calls } = makeClient();

      await migration.up(client);

      const alterIndex = calls.findIndex((c) => /ALTER TABLE/.test(c.text));
      const createIndexIndex = calls.findIndex((c) => /CREATE INDEX/.test(c.text));

      expect(alterIndex).toBe(0);
      expect(createIndexIndex).toBe(1);
    });

    it("sends no bound parameters — DDL is fully deterministic", async () => {
      const { client, calls } = makeClient();

      await migration.up(client);

      for (const call of calls) {
        expect(call.values ?? []).toEqual([]);
      }
    });

    it("resolves to undefined (no leaked return value)", async () => {
      const { client } = makeClient();

      await expect(migration.up(client)).resolves.toBeUndefined();
    });

    // ─── up(): failure / boundary behavior ───────────────────────────────────

    it("propagates an ALTER failure and does not attempt the index afterwards", async () => {
      const boom = new Error('relation "booking_intents" does not exist');
      const { client, calls } = makeClient((text) => {
        if (/ALTER TABLE/.test(text)) {
          return Promise.reject(boom);
        }
        return { rows: [], rowCount: 0 };
      });

      await expect(migration.up(client)).rejects.toBe(boom);
      // Only the failed ALTER was issued — the index must not run on a
      // half-applied schema.
      expect(calls).toHaveLength(1);
      expect(calls[0].text).toMatch(/ALTER TABLE/);
    });

    it("propagates an index creation failure after adding the columns", async () => {
      const boom = new Error("index already exists");
      const { client, calls } = makeClient((text) => {
        if (/CREATE INDEX/.test(text)) {
          return Promise.reject(boom);
        }
        return { rows: [], rowCount: 0 };
      });

      await expect(migration.up(client)).rejects.toBe(boom);
      expect(calls).toHaveLength(2);
      expect(calls[1].text).toMatch(/CREATE INDEX/);
    });

    it("re-throws non-Error rejections unchanged", async () => {
      const nonError = "connection reset";
      const { client } = makeClient(() => Promise.reject(nonError));

      await expect(migration.up(client)).rejects.toBe(nonError);
    });
  });

  // ─── down(): rollback ──────────────────────────────────────────────────────

  describe("down()", () => {
    it("drops both columns in a single idempotent statement", async () => {
      const { client, calls } = makeClient();

      await migration.down(client);

      expect(calls).toHaveLength(1);
      expect(normalize(calls[0].text)).toMatch(
        /^ALTER TABLE booking_intents DROP COLUMN IF EXISTS token_asset, DROP COLUMN IF EXISTS mint_tx_hash$/,
      );
    });

    it("guards every dropped column with IF EXISTS (safe when already rolled back)", async () => {
      const { client, calls } = makeClient();

      await migration.down(client);

      // One IF EXISTS per column keeps the rollback a no-op on a schema that
      // has already been reverted.
      const ifExistsCount = (calls[0].text.match(/IF EXISTS/g) ?? []).length;
      expect(ifExistsCount).toBe(2);
    });

    it("sends no bound parameters", async () => {
      const { client, calls } = makeClient();

      await migration.down(client);

      expect(calls[0].values ?? []).toEqual([]);
    });

    it("resolves to undefined", async () => {
      const { client } = makeClient();

      await expect(migration.down(client)).resolves.toBeUndefined();
    });

    it("is repeatable — running down twice issues the same safe DDL", async () => {
      const { client, calls } = makeClient();

      await migration.down(client);
      await migration.down(client);

      expect(calls).toHaveLength(2);
      expect(normalize(calls[0].text)).toBe(normalize(calls[1].text));
    });

    it("propagates a drop failure", async () => {
      const boom = new Error("permission denied for table booking_intents");
      const { client } = makeClient(() => Promise.reject(boom));

      await expect(migration.down(client)).rejects.toBe(boom);
    });
  });

  // ─── up → down state transition ────────────────────────────────────────────

  describe("up() then down() round-trip", () => {
    it("issues exactly the add-columns, add-index, drop-columns sequence", async () => {
      const { client, calls } = makeClient();

      await migration.up(client);
      await migration.down(client);

      expect(calls).toHaveLength(3);
      expect(calls[0].text).toMatch(/ALTER TABLE[\s\S]*ADD COLUMN token_asset/);
      expect(calls[1].text).toMatch(/CREATE INDEX idx_booking_intents_token_asset/);
      expect(calls[2].text).toMatch(/DROP COLUMN IF EXISTS token_asset/);
    });

    it("names the same columns in both directions", async () => {
      const { client, calls } = makeClient();

      await migration.up(client);
      await migration.down(client);

      for (const column of ["token_asset", "mint_tx_hash"]) {
        expect(calls[0].text).toContain(column);
        expect(calls[2].text).toContain(column);
      }
    });
  });
});
