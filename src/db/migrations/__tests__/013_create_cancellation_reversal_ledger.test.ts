/**
 * Focused behavior coverage for
 * src/db/migrations/013_create_cancellation_reversal_ledger.ts.
 *
 * The migration is exercised against a deterministic in-memory PoolClient so
 * the emitted SQL, ordering, idempotency and failure propagation are asserted
 * without a live Postgres instance.
 */

import { describe, it, expect } from "@jest/globals";
import type { PoolClient } from "pg";
import { migration } from "../013_create_cancellation_reversal_ledger.js";

type FakeQueryResult = { rows: unknown[]; rowCount: number };

/** Records every normalised statement and optionally throws on a given 1-based call. */
function createFakeClient(failOnCall?: number) {
  const statements: string[] = [];
  const query = async (sql: string): Promise<FakeQueryResult> => {
    const index = statements.length + 1;
    statements.push(sql.replace(/\s+/g, " ").trim());
    if (failOnCall === index) {
      throw new Error("connection reset by peer");
    }
    return { rows: [], rowCount: 0 };
  };
  return { client: { query } as unknown as PoolClient, statements };
}

const ledgerSql = (statements: string[]): string => statements.join("\n");

describe("migration 013 create_cancellation_reversal_ledger", () => {
  describe("registry contract", () => {
    it("exposes the id/name consumed by the migration registry", () => {
      expect(migration.id).toBe("019");
      expect(migration.name).toBe("create_cancellation_reversal_ledger");
      expect(typeof migration.up).toBe("function");
      expect(typeof migration.down).toBe("function");
    });
  });

  describe("up()", () => {
    it("creates the ledger table with every documented column", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = ledgerSql(statements);

      expect(text).toContain("CREATE TABLE cancellation_reversal_entries");

      const columns = [
        "id",
        "booking_intent_id",
        "payment_id",
        "original_refund_id",
        "amount_cents",
        "currency",
        "escrow_released",
        "escrow_released_amount_cents",
        "escrow_release_tx_id",
        "reason",
        "idempotency_key",
        "policy_version_id",
        "actor",
        "metadata",
        "entry_hash",
        "prev_hash",
        "created_at",
      ];
      for (const column of columns) {
        expect(text).toMatch(new RegExp(`\\b${column}\\b`));
      }
    });

    it("links booking, payment and refund rows with cascade rules", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = ledgerSql(statements);

      expect(text).toMatch(/booking_intent_id\s+UUID\s+NOT NULL REFERENCES booking_intents\(id\) ON DELETE CASCADE/);
      expect(text).toMatch(/payment_id\s+UUID\s+NOT NULL REFERENCES checkout_sessions\(id\) ON DELETE CASCADE/);
      expect(text).toMatch(/original_refund_id\s+UUID\s+REFERENCES refund_entries\(id\) ON DELETE SET NULL/);
    });

    it("enforces the uniqueness and sign/bounds invariants in the database", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = ledgerSql(statements);

      expect(text).toMatch(/idempotency_key\s+TEXT\s+NOT NULL UNIQUE/);
      expect(text).toMatch(/entry_hash\s+TEXT\s+NOT NULL UNIQUE/);
      expect(text).toContain("CHECK (amount_cents <> 0)");
      expect(text).toContain("CHECK (escrow_released_amount_cents >= 0)");
      expect(text).toContain("CHECK (currency IN ('USD','EUR','GBP','XLM'))");
    });

    it("defaults escrow bookkeeping flags and the creation timestamp", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = ledgerSql(statements);

      expect(text).toMatch(/escrow_released\s+BOOLEAN\s+NOT NULL DEFAULT FALSE/);
      expect(text).toMatch(/escrow_released_amount_cents\s+BIGINT\s+NOT NULL DEFAULT 0/);
      expect(text).toMatch(/created_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT NOW\(\)/);
    });

    it("allows at most one genesis row through a partial unique index", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = ledgerSql(statements);

      expect(text).toMatch(/CREATE UNIQUE INDEX idx_cancellation_reversal_genesis[\s\S]*WHERE prev_hash IS NULL/);
    });

    it("creates the chain-walk, lookup and invariant indexes", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = ledgerSql(statements);

      const indexes = [
        "idx_cancellation_reversal_genesis",
        "idx_cancellation_reversal_prev_hash",
        "idx_cancellation_reversal_created_at",
        "idx_cancellation_reversal_payment_id",
        "idx_cancellation_reversal_booking_intent_id",
        "idx_cancellation_reversal_escrow_tx_id",
      ];
      for (const index of indexes) {
        expect(text).toContain(index);
      }
      // The escrow index is partial — only bound transactions are indexed.
      expect(text).toMatch(/CREATE INDEX idx_cancellation_reversal_escrow_tx_id[\s\S]*WHERE escrow_release_tx_id IS NOT NULL/);
    });

    it("runs every statement inside the injected transaction client", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);

      expect(statements).toHaveLength(7);
      expect(statements[0]).toContain("CREATE TABLE cancellation_reversal_entries");
      expect(statements.every((s) => s.length > 0)).toBe(true);
    });
  });

  describe("down()", () => {
    it("drops the table idempotently", async () => {
      const { client, statements } = createFakeClient();
      await migration.down(client);

      expect(statements).toEqual(["DROP TABLE IF EXISTS cancellation_reversal_entries"]);
    });
  });

  describe("failure handling", () => {
    it("propagates an up() failure and stops on the first failing statement", async () => {
      const { client, statements } = createFakeClient(3);
      await expect(migration.up(client)).rejects.toThrow("connection reset by peer");
      expect(statements).toHaveLength(3);
    });

    it("propagates a down() failure to the caller", async () => {
      const { client } = createFakeClient(1);
      await expect(migration.down(client)).rejects.toThrow("connection reset by peer");
    });
  });
});
