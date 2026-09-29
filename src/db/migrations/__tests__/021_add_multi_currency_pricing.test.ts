/**
 * Focused behaviour suite for `migration` in
 * `src/db/migrations/021_add_multi_currency_pricing.ts` (issue #1063).
 *
 * The module's contract is entirely about the SQL it issues and the order it
 * issues it in:
 *
 *  - `up()` adds `currency`/`amount_minor` to `slots` and `fx_rate_snapshot`
 *    to `booking_intents`.
 *  - `down()` reverses both changes in the opposite order.
 *  - It is a pure, dependency-injected unit: it receives a client and issues
 *    statements on it; it never opens a connection, manages transactions, or
 *    releases the client it does not own.
 *
 * The migration is driven with an injected recording client so every assertion
 * is on observed calls rather than on a live database, keeping the failure and
 * boundary behaviour deterministic. No production code is changed.
 */

import { jest, describe, it, expect } from "@jest/globals";
import type { PoolClient } from "pg";
import { migration } from "../021_add_multi_currency_pricing.js";

type RecordedCall = { text: string; values: unknown[] | undefined };

/** Collapses the DDL's indentation so assertions read as SQL. */
const sql = (text: string): string => text.replace(/\s+/g, " ").trim();

interface RecordingClient {
  client: PoolClient;
  calls: RecordedCall[];
  query: ReturnType<typeof jest.fn>;
}

function recordingClient(): RecordingClient {
  const calls: RecordedCall[] = [];
  const query = jest.fn<any>(async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    return { rows: [] };
  });
  return { client: { query } as unknown as PoolClient, calls, query };
}

describe("migration 021_add_multi_currency_pricing", () => {
  describe("contract", () => {
    it("exposes the id/name/up/down shape required by the migration runner", () => {
      expect(migration.id).toBe("021");
      expect(migration.name).toBe("add_multi_currency_pricing");
      expect(typeof migration.up).toBe("function");
      expect(typeof migration.down).toBe("function");
    });

    it("uses a non-empty, trimmed id and name", () => {
      expect(migration.id.trim()).not.toBe("");
      expect(migration.name.trim()).not.toBe("");
    });
  });

  describe("up()", () => {
    it("alters slots before booking_intents (state-transition ordering)", async () => {
      const { client, calls } = recordingClient();

      await migration.up(client);

      const statements = calls.map((call) => sql(call.text));
      expect(statements).toHaveLength(2);
      expect(statements[0]).toMatch(/^ALTER TABLE slots/i);
      expect(statements[1]).toMatch(/^ALTER TABLE booking_intents/i);
    });

    it("adds currency as VARCHAR(3) and amount_minor as BIGINT to slots", async () => {
      const { client, calls } = recordingClient();

      await migration.up(client);

      const slots = sql(calls[0].text);
      expect(slots).toContain("ADD COLUMN currency VARCHAR(3)");
      expect(slots).toContain("ADD COLUMN amount_minor BIGINT");
    });

    it("adds fx_rate_snapshot as JSONB to booking_intents", async () => {
      const { client, calls } = recordingClient();

      await migration.up(client);

      const intents = sql(calls[1].text);
      expect(intents).toContain("ADD COLUMN fx_rate_snapshot JSONB");
    });

    it("keeps every new column nullable so existing rows remain valid", async () => {
      const { client, calls } = recordingClient();

      await migration.up(client);

      const allSql = calls.map((call) => sql(call.text)).join(" ");
      expect(allSql).not.toMatch(/currency[^,;]*NOT NULL/i);
      expect(allSql).not.toMatch(/amount_minor[^,;]*NOT NULL/i);
      expect(allSql).not.toMatch(/fx_rate_snapshot[^,;]*NOT NULL/i);
    });

    it("issues DDL only, with no bound parameter values", async () => {
      const { client, calls } = recordingClient();

      await migration.up(client);

      for (const call of calls) {
        expect(call.values).toBeUndefined();
      }
    });

    it("fail-fast: propagates the first statement's error without issuing the second", async () => {
      const { client, query } = recordingClient();
      const dbError = new Error('column "currency" of relation "slots" already exists');
      query.mockRejectedValueOnce(dbError);

      await expect(migration.up(client)).rejects.toThrow(dbError);
      expect(query).toHaveBeenCalledTimes(1);
    });

    it("fail-fast: propagates a later statement's error without swallowing it", async () => {
      const { client, query } = recordingClient();
      query
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(new Error('relation "booking_intents" does not exist'));

      await expect(migration.up(client)).rejects.toThrow(
        'relation "booking_intents" does not exist',
      );
      expect(query).toHaveBeenCalledTimes(2);
    });
  });

  describe("down()", () => {
    it("reverts booking_intents before slots (reverse of up ordering)", async () => {
      const { client, calls } = recordingClient();

      await migration.down(client);

      const statements = calls.map((call) => sql(call.text));
      expect(statements).toHaveLength(2);
      expect(statements[0]).toMatch(/^ALTER TABLE booking_intents/i);
      expect(statements[1]).toMatch(/^ALTER TABLE slots/i);
    });

    it("drops fx_rate_snapshot, then both slots columns", async () => {
      const { client, calls } = recordingClient();

      await migration.down(client);

      const statements = calls.map((call) => sql(call.text));
      expect(statements[0]).toContain("DROP COLUMN fx_rate_snapshot");
      expect(statements[1]).toContain("DROP COLUMN amount_minor");
      expect(statements[1]).toContain("DROP COLUMN currency");
    });

    it("fail-fast: propagates the first drop's error without issuing the second", async () => {
      const { client, query } = recordingClient();
      const dbError = new Error('column "fx_rate_snapshot" does not exist');
      query.mockRejectedValueOnce(dbError);

      await expect(migration.down(client)).rejects.toThrow(dbError);
      expect(query).toHaveBeenCalledTimes(1);
    });

    it("fail-fast: propagates a later drop's error", async () => {
      const { client, query } = recordingClient();
      query
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(new Error('column "currency" does not exist'));

      await expect(migration.down(client)).rejects.toThrow(
        'column "currency" does not exist',
      );
      expect(query).toHaveBeenCalledTimes(2);
    });
  });
});
