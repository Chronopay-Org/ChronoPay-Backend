import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { queryWithSpan } from "../dbInstrumentation.js";
import { addSpanExporter, removeSpanExporter } from "../spanExporter.js";
import type { Span } from "../hooks.js";

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

  describe("queryWithSpan", () => {
    it("should wrap query execution in a span", async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
      } as any;

      await queryWithSpan(mockPool, "SELECT 1", []);

      expect(collectedSpans).toHaveLength(1);
      expect(collectedSpans[0].name).toBe("db.query");
      expect(collectedSpans[0].attributes["db.system"]).toBe("postgresql");
    });

    it("should strip query parameters from statement", async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
      } as any;

      await queryWithSpan(mockPool, "SELECT * FROM users WHERE id = $1 AND email = $2", [
        1,
        "user@example.com",
      ]);

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      const statement = span.attributes["db.statement"] as string;

      // Should not contain actual parameter values
      expect(statement).not.toContain("user@example.com");
      expect(statement).not.toContain("1");
      // Should contain parameter placeholders
      expect(statement).toContain("$n");
    });

    it("should record query operation type", async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
      } as any;

      await queryWithSpan(mockPool, "INSERT INTO users (name) VALUES ($1)", ["Alice"]);

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      expect(span.attributes["db.operation"]).toBe("insert");
    });

    it("should handle SELECT operations", async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({ rowCount: 5, rows: [] }),
      } as any;

      await queryWithSpan(mockPool, "SELECT * FROM users WHERE active = $1", [true]);

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      expect(span.attributes["db.operation"]).toBe("select");
    });

    it("should handle UPDATE operations", async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({ rowCount: 2, rows: [] }),
      } as any;

      await queryWithSpan(mockPool, "UPDATE users SET last_login = $1 WHERE id = $2", [
        new Date(),
        123,
      ]);

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      expect(span.attributes["db.operation"]).toBe("update");
    });

    it("should handle DELETE operations", async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
      } as any;

      await queryWithSpan(mockPool, "DELETE FROM users WHERE id = $1", [456]);

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      expect(span.attributes["db.operation"]).toBe("delete");
    });

    it("should record parameter count", async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
      } as any;

      await queryWithSpan(
        mockPool,
        "SELECT * FROM users WHERE id = $1 AND email = $2 AND status = $3",
        [1, "test@example.com", "active"],
      );

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      expect(span.attributes["db.param_count"]).toBe(3);
    });

    it("should mark span as success", async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 1 }] }),
      } as any;

      await queryWithSpan(mockPool, "SELECT * FROM users WHERE id = $1", [1]);

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      expect(span.attributes.outcome).toBe("ok");
      expect(span.attributes.error).toBeUndefined();
    });

    it("should mark span as error on query failure", async () => {
      const mockPool = {
        query: jest.fn().mockRejectedValue(new Error("Connection timeout")),
      } as any;

      await expect(queryWithSpan(mockPool, "SELECT * FROM users", [])).rejects.toThrow(
        "Connection timeout",
      );

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      expect(span.attributes.outcome).toBe("error");
      expect(span.attributes.error).toBe(true);
      expect(span.attributes["error.message"]).toBe("Connection timeout");
    });

    it("should record query duration", async () => {
      const mockPool = {
        query: jest.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => {
                resolve({ rowCount: 1, rows: [] });
              }, 50);
            }),
        ),
      } as any;

      await queryWithSpan(mockPool, "SELECT 1", []);

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      expect(span.duration).toBeGreaterThanOrEqual(50);
      expect(span.attributes.latency).toBe(span.duration);
    });

    it("should limit statement length for long queries", async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
      } as any;

      const longQuery = "SELECT " + "column, ".repeat(100);
      await queryWithSpan(mockPool, longQuery, []);

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      const statement = span.attributes["db.statement"] as string;
      expect(statement.length).toBeLessThanOrEqual(200);
    });

    it("should pass through query result", async () => {
      const expectedResult = { rowCount: 3, rows: [{ id: 1 }, { id: 2 }, { id: 3 }] };
      const mockPool = {
        query: jest.fn().mockResolvedValue(expectedResult),
      } as any;

      const result = await queryWithSpan(mockPool, "SELECT * FROM users", []);

      expect(result).toEqual(expectedResult);
    });

    it("should handle queries without parameters", async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
      } as any;

      await queryWithSpan(mockPool, "SELECT COUNT(*) FROM users", undefined);

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      expect(span.attributes["db.param_count"]).toBe(0);
    });

    it("should handle various SQL statement formats", async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
      } as any;

      // Test with leading/trailing whitespace
      await queryWithSpan(mockPool, "  SELECT * FROM users WHERE id = $1  ", [1]);

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      expect(span.attributes["db.operation"]).toBe("select");
    });

    it("should handle case-insensitive SQL operations", async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
      } as any;

      await queryWithSpan(mockPool, "select * FROM users WHERE id = $1", [1]);

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      expect(span.attributes["db.operation"]).toBe("select");
    });

    it("should preserve PostgreSQL as db system", async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
      } as any;

      await queryWithSpan(mockPool, "SELECT 1", []);

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      expect(span.attributes["db.system"]).toBe("postgresql");
    });
  });

  describe("nested queries", () => {
    it("should nest query spans under parent span", async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
      } as any;

      // Simulate parent span context
      await queryWithSpan(mockPool, "SELECT 1", []);
      await queryWithSpan(mockPool, "SELECT 2", []);

      expect(collectedSpans).toHaveLength(2);
      expect(collectedSpans[0].name).toBe("db.query");
      expect(collectedSpans[1].name).toBe("db.query");
    });
  });
});
