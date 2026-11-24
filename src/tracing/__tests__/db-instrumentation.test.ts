import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { queryWithSpan, instrumentPool } from "../dbInstrumentation.js";
import { addSpanExporter, removeSpanExporter } from "../spanExporter.js";
import type { Span } from "../hooks.js";
import type { Pool, QueryResult } from "pg";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal fake pool whose query method is a jest mock. */
function makeFakePool(result: Partial<QueryResult> = { rowCount: 1, rows: [] }): Pool & {
  query: jest.Mock;
} {
  const pool = {
    query: jest.fn().mockResolvedValue(result),
  } as unknown as Pool & { query: jest.Mock };
  return pool;
}

/** Convenience: extract the bound `runQuery` from a fake pool. */
function runQueryOf(pool: Pool & { query: jest.Mock }) {
  return pool.query.bind(pool) as (text: string, params?: unknown[]) => Promise<QueryResult>;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("DB Instrumentation", () => {
  const collectedSpans: Span[] = [];
  let exporter: (span: Span) => void;

  beforeEach(() => {
    collectedSpans.length = 0;
    exporter = (span: Span) => {
      collectedSpans.push({ ...span });
    };
    addSpanExporter(exporter);
  });

  afterEach(() => {
    removeSpanExporter(exporter);
    collectedSpans.length = 0;
  });

  // -------------------------------------------------------------------------
  // queryWithSpan
  // -------------------------------------------------------------------------
  describe("queryWithSpan", () => {
    it("should wrap query execution in a span", async () => {
      const pool = makeFakePool();

      await queryWithSpan(runQueryOf(pool), "SELECT 1", []);

      expect(collectedSpans).toHaveLength(1);
      expect(collectedSpans[0].name).toBe("db.query");
      expect(collectedSpans[0].attributes["db.system"]).toBe("postgresql");
    });

    it("should strip query parameters from statement", async () => {
      const pool = makeFakePool();

      await queryWithSpan(
        runQueryOf(pool),
        "SELECT * FROM users WHERE id = $1 AND email = $2",
        [1, "user@example.com"],
      );

      expect(collectedSpans).toHaveLength(1);
      const statement = collectedSpans[0].attributes["db.statement"] as string;
      expect(statement).not.toContain("user@example.com");
      expect(statement).not.toContain("1");
      expect(statement).toContain("$n");
    });

    it("should record query operation type for INSERT", async () => {
      const pool = makeFakePool();

      await queryWithSpan(
        runQueryOf(pool),
        "INSERT INTO users (name) VALUES ($1)",
        ["Alice"],
      );

      expect(collectedSpans).toHaveLength(1);
      expect(collectedSpans[0].attributes["db.operation"]).toBe("insert");
    });

    it("should handle SELECT operations", async () => {
      const pool = makeFakePool({ rowCount: 5, rows: [] });

      await queryWithSpan(
        runQueryOf(pool),
        "SELECT * FROM users WHERE active = $1",
        [true],
      );

      expect(collectedSpans).toHaveLength(1);
      expect(collectedSpans[0].attributes["db.operation"]).toBe("select");
    });

    it("should handle UPDATE operations", async () => {
      const pool = makeFakePool({ rowCount: 2, rows: [] });

      await queryWithSpan(
        runQueryOf(pool),
        "UPDATE users SET last_login = $1 WHERE id = $2",
        [new Date(), 123],
      );

      expect(collectedSpans).toHaveLength(1);
      expect(collectedSpans[0].attributes["db.operation"]).toBe("update");
    });

    it("should handle DELETE operations", async () => {
      const pool = makeFakePool();

      await queryWithSpan(
        runQueryOf(pool),
        "DELETE FROM users WHERE id = $1",
        [456],
      );

      expect(collectedSpans).toHaveLength(1);
      expect(collectedSpans[0].attributes["db.operation"]).toBe("delete");
    });

    it("should record parameter count", async () => {
      const pool = makeFakePool();

      await queryWithSpan(
        runQueryOf(pool),
        "SELECT * FROM users WHERE id = $1 AND email = $2 AND status = $3",
        [1, "test@example.com", "active"],
      );

      expect(collectedSpans).toHaveLength(1);
      expect(collectedSpans[0].attributes["db.param_count"]).toBe(3);
    });

    it("should mark span as success", async () => {
      const pool = makeFakePool({ rowCount: 1, rows: [{ id: 1 }] });

      await queryWithSpan(runQueryOf(pool), "SELECT * FROM users WHERE id = $1", [1]);

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      expect(span.attributes.outcome).toBe("ok");
      expect(span.attributes.error).toBeUndefined();
    });

    it("should mark span as error on query failure", async () => {
      const pool = makeFakePool();
      (pool.query as jest.Mock).mockRejectedValue(new Error("Connection timeout"));

      await expect(
        queryWithSpan(runQueryOf(pool), "SELECT * FROM users", []),
      ).rejects.toThrow("Connection timeout");

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      expect(span.attributes.outcome).toBe("error");
      expect(span.attributes.error).toBe(true);
      expect(span.attributes["error.message"]).toBe("Connection timeout");
    });

    it("should record query duration", async () => {
      let now = 1_000;
      const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);

      try {
        const pool = makeFakePool();
        (pool.query as jest.Mock).mockImplementation(() => {
          now += 250;
          return Promise.resolve({ rowCount: 1, rows: [] });
        });

        await queryWithSpan(runQueryOf(pool), "SELECT 1", []);

        expect(collectedSpans).toHaveLength(1);
        const span = collectedSpans[0];
        expect(span.duration).toBe(250);
        expect(span.attributes.latency).toBe(span.duration);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("should limit statement length for long queries", async () => {
      const pool = makeFakePool();
      const longQuery = "SELECT " + "column, ".repeat(100);

      await queryWithSpan(runQueryOf(pool), longQuery, []);

      expect(collectedSpans).toHaveLength(1);
      const statement = collectedSpans[0].attributes["db.statement"] as string;
      expect(statement.length).toBeLessThanOrEqual(200);
    });

    it("should pass through query result", async () => {
      const expectedResult = { rowCount: 3, rows: [{ id: 1 }, { id: 2 }, { id: 3 }] };
      const pool = makeFakePool(expectedResult);

      const result = await queryWithSpan(runQueryOf(pool), "SELECT * FROM users", []);

      expect(result).toEqual(expectedResult);
    });

    it("should handle queries without parameters", async () => {
      const pool = makeFakePool();

      await queryWithSpan(runQueryOf(pool), "SELECT COUNT(*) FROM users", undefined);

      expect(collectedSpans).toHaveLength(1);
      expect(collectedSpans[0].attributes["db.param_count"]).toBe(0);
    });

    it("should handle various SQL statement formats (leading whitespace)", async () => {
      const pool = makeFakePool();

      await queryWithSpan(
        runQueryOf(pool),
        "  SELECT * FROM users WHERE id = $1  ",
        [1],
      );

      expect(collectedSpans).toHaveLength(1);
      expect(collectedSpans[0].attributes["db.operation"]).toBe("select");
    });

    it("should handle case-insensitive SQL operations", async () => {
      const pool = makeFakePool();

      await queryWithSpan(
        runQueryOf(pool),
        "select * FROM users WHERE id = $1",
        [1],
      );

      expect(collectedSpans).toHaveLength(1);
      expect(collectedSpans[0].attributes["db.operation"]).toBe("select");
    });

    it("should preserve PostgreSQL as db system", async () => {
      const pool = makeFakePool();

      await queryWithSpan(runQueryOf(pool), "SELECT 1", []);

      expect(collectedSpans).toHaveLength(1);
      expect(collectedSpans[0].attributes["db.system"]).toBe("postgresql");
    });
  });

  // -------------------------------------------------------------------------
  // nested queries
  // -------------------------------------------------------------------------
  describe("nested queries", () => {
    it("should produce one span per query call", async () => {
      const pool = makeFakePool();

      await queryWithSpan(runQueryOf(pool), "SELECT 1", []);
      await queryWithSpan(runQueryOf(pool), "SELECT 2", []);

      expect(collectedSpans).toHaveLength(2);
      expect(collectedSpans[0].name).toBe("db.query");
      expect(collectedSpans[1].name).toBe("db.query");
    });
  });

  // -------------------------------------------------------------------------
  // instrumentPool — no-recursion and idempotency
  // -------------------------------------------------------------------------
  describe("instrumentPool", () => {
    it("should invoke the underlying query exactly once per wrapped call", async () => {
      const pool = makeFakePool();
      // Capture the original mock before instrumentPool replaces pool.query.
      const originalMock = pool.query as jest.Mock;

      instrumentPool(pool);
      await pool.query("SELECT 1", []);

      // The original mock must have been called exactly once — not recursively.
      expect(originalMock.mock.calls.length).toBe(1);
      expect(collectedSpans).toHaveLength(1);
    });

    it("double instrumentation does not nest spans", async () => {
      const pool = makeFakePool();

      instrumentPool(pool);
      instrumentPool(pool); // second call must be a no-op
      await pool.query("SELECT 1", []);

      // Still exactly one span, not two.
      expect(collectedSpans).toHaveLength(1);
    });

    it("double instrumentation does not cause the original to be called more than once", async () => {
      // Track calls to the real underlying function separately.
      let underlyingCalls = 0;
      const pool = {
        query: jest.fn().mockImplementation(() => {
          underlyingCalls++;
          return Promise.resolve({ rowCount: 1, rows: [] });
        }),
      } as unknown as Pool & { query: jest.Mock };

      instrumentPool(pool);
      instrumentPool(pool);
      await pool.query("SELECT 1", []);

      expect(underlyingCalls).toBe(1);
    });
  });
});
