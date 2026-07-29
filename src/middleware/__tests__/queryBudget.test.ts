import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

// ── Module-level mocks ────────────────────────────────────────────────────────

const mockQuery = jest.fn<(...args: any[]) => Promise<any>>();
const mockPool: any = {
  query: mockQuery,
  on: jest.fn(),
};

// Mock pg module
jest.unstable_mockModule("pg", () => ({
  Pool: jest.fn().mockImplementation(() => mockPool),
  default: { Pool: jest.fn().mockImplementation(() => mockPool) },
}));

// Mock the metrics module
const mockQueryBudgetBreaches = {
  labels: jest.fn().mockReturnValue({ inc: jest.fn() }),
};
const mockQueryBudgetSqlTimeMs = {
  labels: jest.fn().mockReturnValue({ observe: jest.fn() }),
};

jest.unstable_mockModule("../../metrics.js", () => ({
  queryBudgetBreaches: mockQueryBudgetBreaches,
  queryBudgetSqlTimeMs: mockQueryBudgetSqlTimeMs,
  slowQueryCounter: { inc: jest.fn() },
  slowQueryDuration: { observe: jest.fn() },
  register: { contentType: "text/plain", metrics: jest.fn() },
}));

// We need the connection module to export the budget breach recording functions
// The pool module imports from connection.js, so we need to import it properly.
// We'll use dynamic imports to load after mocks are in place.

// ── Imports ───────────────────────────────────────────────────────────────────

const { createQueryBudgetMiddleware } = await import("../queryBudget.js");
const { runWithQueryBudget, getQueryBudgetContext } = await import("../../db/queryBudgetContext.js");
const { isStatementTimeoutError, _recordBudgetBreach } = await import("../../db/connection.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function createTestApp(
  budgetMs?: number,
  routeHandler?: (req: Request, res: Response) => Promise<void> | void,
) {
  const app = express();
  app.use(express.json());
  app.use(createQueryBudgetMiddleware({ budgetMs }));

  if (routeHandler) {
    app.get("/test", routeHandler);
  }

  app.get("/test", (_req, res) => {
    res.json({ ok: true });
  });

  // Error handler for budget breaches (simulates what the global error handler does)
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.code === "QUERY_BUDGET_EXCEEDED") {
      res.status(503).json({
        success: false,
        code: "QUERY_BUDGET_EXCEEDED",
        error: err.message,
      });
      return;
    }
    res.status(500).json({ success: false, error: "Internal error" });
  });

  return app;
}

describe("queryBudgetMiddleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    // Default: queries succeed immediately
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  describe("budget context lifecycle", () => {
    it("sets a query budget context for the request duration", async () => {
      let capturedContext: any;
      const app = createTestApp();
      app.get("/capture", (_req, res) => {
        capturedContext = getQueryBudgetContext();
        res.json({ ok: true });
      });

      await request(app).get("/capture");

      expect(capturedContext).toBeDefined();
      expect(capturedContext.budgetMs).toBe(30000); // default
      expect(capturedContext.totalSqlTimeMs).toBe(0);
      expect(capturedContext.breached).toBe(false);
    });

    it("does NOT leak context between requests", async () => {
      const contexts: any[] = [];
      const app = createTestApp();
      app.get("/ctx", (_req, res) => {
        contexts.push(getQueryBudgetContext());
        res.json({ ok: true });
      });

      await request(app).get("/ctx");
      await request(app).get("/ctx");

      // Each request should have its own context
      expect(contexts[0]).not.toBe(contexts[1]);
      // Context should be cleared after the request
      expect(getQueryBudgetContext()).toBeUndefined();
    });

    it("has NO context outside a request", () => {
      expect(getQueryBudgetContext()).toBeUndefined();
    });
  });

  describe("budget resolution", () => {
    it("uses explicit budgetMs when provided", async () => {
      let context: any;
      const app = createTestApp(5000);
      app.get("/explicit", (_req, res) => {
        context = getQueryBudgetContext();
        res.json({ ok: true });
      });

      await request(app).get("/explicit");
      expect(context.budgetMs).toBe(5000);
    });

    it("falls back to default budget (30000ms) when no explicit budget", async () => {
      let context: any;
      const app = createTestApp();
      app.get("/default-only", (_req, res) => {
        context = getQueryBudgetContext();
        res.json({ ok: true });
      });

      await request(app).get("/default-only");
      expect(context.budgetMs).toBe(30000);
    });
  });

  describe("statement_timeout error detection", () => {
    it("isStatementTimeoutError returns true for error with code 57014", () => {
      const err = Object.assign(new Error("canceling statement due to statement timeout"), {
        code: "57014",
      });
      expect(isStatementTimeoutError(err)).toBe(true);
    });

    it("isStatementTimeoutError returns false for regular errors", () => {
      expect(isStatementTimeoutError(new Error("normal error"))).toBe(false);
      expect(isStatementTimeoutError(null)).toBe(false);
      expect(isStatementTimeoutError("string")).toBe(false);
    });
  });

  describe("breach recording", () => {
    it("_recordBudgetBreach increments the breach counter", () => {
      const incMock = jest.fn();
      mockQueryBudgetBreaches.labels.mockReturnValue({ inc: incMock });

      _recordBudgetBreach("SELECT * FROM big_table", 5000, "/api/v1/slow");

      expect(mockQueryBudgetBreaches.labels).toHaveBeenCalledWith("/api/v1/slow");
      expect(incMock).toHaveBeenCalled();
    });
  });

  describe("SQL time accumulation", () => {
    it("accumulates SQL time across multiple queries in the budget context", async () => {
      // Simulate controlled query durations
      let queryCount = 0;
      mockQuery.mockImplementation(async (_text: string, _params?: unknown[]) => {
        queryCount++;
        if (queryCount === 1) {
          return new Promise((resolve) => setTimeout(() => resolve({ rows: [], rowCount: 0 }), 10));
        }
        return { rows: [], rowCount: 0 };
      });

      let context: any;
      const app = createTestApp(60000);
      app.get("/multi-query", async (_req, res) => {
        context = getQueryBudgetContext();
        // Simulate two queries via the pool (the mock tracks them)
        // In real usage this would be pool.query(...)
        const { query } = await import("../../db/pool.js");
        await query("SELECT 1");
        await query("SELECT 2");
        res.json({ ok: true, totalMs: context.totalSqlTimeMs });
      });

      const response = await request(app).get("/multi-query");
      expect(response.status).toBe(200);
      // Context should have accumulated time from both queries
      expect(context.totalSqlTimeMs).toBeGreaterThan(0);
    });

    it("tracks SQL time on the response finish event", async () => {
      const observeMock = jest.fn();
      mockQueryBudgetSqlTimeMs.labels.mockReturnValue({ observe: observeMock });

      const app = createTestApp(60000);
      app.get("/timed", async (_req, res) => {
        const { query } = await import("../../db/pool.js");
        await query("SELECT 1");
        res.json({ ok: true });
      });

      await request(app).get("/timed");

      // Should have recorded SQL time on the histogram
      expect(mockQueryBudgetSqlTimeMs.labels).toHaveBeenCalled();
    });
  });

  describe("budget breach handling", () => {
    it("marks context as breached when a query exceeds statement_timeout", async () => {
      mockQuery.mockImplementation(async (text: string) => {
        if (text.includes("SET LOCAL statement_timeout")) {
          return { rows: [], rowCount: 0 };
        }
        // Simulate a query_canceled error
        const err: any = new Error("canceling statement due to statement timeout");
        err.code = "57014";
        throw err;
      });

      let context: any;
      const app = createTestApp(100); // very tight budget
      app.get("/slow", async (_req, _res, next) => {
        context = getQueryBudgetContext();
        try {
          const { query } = await import("../../db/pool.js");
          await query("SELECT pg_sleep(1)");
        } catch (err: any) {
          next(err);
        }
      });

      await request(app).get("/slow");
      expect(context.breached).toBe(true);
    });

    it("throws QueryBudgetExceededError (typed error) on budget breach", async () => {
      // Use a fresh app with explicit error handling order
      const app = express();
      app.use(express.json());
      app.use(createQueryBudgetMiddleware({ budgetMs: 50 }));

      app.get("/typed-error", async (_req, _res, next) => {
        try {
          const { query } = await import("../../db/pool.js");
          await query("SELECT pg_sleep(10)");
        } catch (err: any) {
          next(err);
        }
      });

      // Error handler placed AFTER routes (standard Express pattern)
      app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
        if (err?.code === "QUERY_BUDGET_EXCEEDED") {
          res.status(503).json({
            success: false,
            code: "QUERY_BUDGET_EXCEEDED",
            error: err.message,
          });
          return;
        }
        res.status(500).json({ success: false, error: "Internal error" });
      });

      mockQuery.mockImplementation(async (text: string) => {
        if (text.includes("SET LOCAL")) return { rows: [], rowCount: 0 };
        const err: any = new Error("canceling statement due to statement timeout");
        err.code = "57014";
        throw err;
      });

      const response = await request(app).get("/typed-error");
      expect(response.status).toBe(503);
      expect(response.body.code).toBe("QUERY_BUDGET_EXCEEDED");
    });

    it("records a breach metric on budget exceed", async () => {
      const incMock = jest.fn();
      mockQueryBudgetBreaches.labels.mockReturnValue({ inc: incMock });

      mockQuery.mockImplementation(async (text: string) => {
        if (text.includes("SET LOCAL")) return { rows: [], rowCount: 0 };
        const err: any = new Error("canceling statement due to statement timeout");
        err.code = "57014";
        throw err;
      });

      const app = createTestApp(50);
      app.get("/breach-metric", async (_req, _res, next) => {
        try {
          const { query } = await import("../../db/pool.js");
          await query("SELECT pg_sleep(10)");
        } catch (err: any) {
          next(err);
        }
      });

      await request(app).get("/breach-metric");
      expect(incMock).toHaveBeenCalled();
    });
  });

  describe("passthrough: no budget context", () => {
    it("pool.query works normally when no budget context is active", async () => {
      mockQuery.mockResolvedValue({ rows: [{ connected: 1 }], rowCount: 1 });

      // Direct query outside any request context
      const { query } = await import("../../db/pool.js");
      const result = await query("SELECT 1 AS connected");

      expect(result.rows[0].connected).toBe(1);
      // Should NOT have tried to set statement_timeout
      const setLocalCalls = mockQuery.mock.calls.filter(
        (call: any[]) => typeof call[0] === "string" && call[0].includes("SET LOCAL statement_timeout"),
      );
      expect(setLocalCalls.length).toBe(0);
    });
  });

  describe("concurrent requests", () => {
    it("each concurrent request has an isolated budget context", async () => {
      const contexts: Array<{ budgetMs: number; breached: boolean }> = [];
      const app = createTestApp();
      app.get("/concurrent/:id", (_req, res) => {
        const ctx = getQueryBudgetContext()!;
        contexts.push({ budgetMs: ctx.budgetMs, breached: ctx.breached });
        res.json({ ok: true });
      });

      await Promise.all([
        request(app).get("/concurrent/a"),
        request(app).get("/concurrent/b"),
        request(app).get("/concurrent/c"),
      ]);

      expect(contexts).toHaveLength(3);
      contexts.forEach((ctx) => {
        expect(ctx.budgetMs).toBe(30000);
        expect(ctx.breached).toBe(false);
      });
    });
  });

  describe("SET LOCAL statement_timeout integration", () => {
    it("sends SET LOCAL statement_timeout before each query when budget context is active", async () => {
      const setLocalCalls: string[] = [];
      mockQuery.mockImplementation(async (text: string) => {
        if (text.includes("SET LOCAL statement_timeout")) {
          setLocalCalls.push(text);
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      });

      const app = createTestApp(5000);
      app.get("/with-budget", async (_req, res) => {
        const { query } = await import("../../db/pool.js");
        await query("SELECT 1");
        await query("SELECT 2");
        res.json({ ok: true });
      });

      await request(app).get("/with-budget");

      expect(setLocalCalls.length).toBe(2);
      expect(setLocalCalls[0]).toContain("5000ms");
      expect(setLocalCalls[1]).toContain("5000ms");
    });

    it("does NOT send SET LOCAL when budget context is not active", async () => {
      const { query } = await import("../../db/pool.js");
      await query("SELECT 1");

      const setLocalCalls = mockQuery.mock.calls.filter(
        (call: any[]) => typeof call[0] === "string" && call[0].includes("SET LOCAL"),
      );
      expect(setLocalCalls.length).toBe(0);
    });

    it("proceeds normally when SET LOCAL fails (backward compat)", async () => {
      let actualQueryRan = false;
      mockQuery.mockImplementation(async (text: string) => {
        if (text.includes("SET LOCAL statement_timeout")) {
          throw new Error("syntax error");
        }
        actualQueryRan = true;
        return { rows: [], rowCount: 0 };
      });

      const app = createTestApp(5000);
      app.get("/old-pg", async (_req, res) => {
        const { query } = await import("../../db/pool.js");
        await query("SELECT 1");
        res.json({ ok: true });
      });

      const response = await request(app).get("/old-pg");
      expect(response.status).toBe(200);
      expect(actualQueryRan).toBe(true);
    });
  });
});

describe("_recordBudgetBreach (unit)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls queryBudgetBreaches.labels with the route and inc", () => {
    const incMock = jest.fn();
    mockQueryBudgetBreaches.labels.mockReturnValue({ inc: incMock });

    _recordBudgetBreach("SELECT * FROM users", 5000, "/api/v1/admin");

    expect(mockQueryBudgetBreaches.labels).toHaveBeenCalledWith("/api/v1/admin");
    expect(incMock).toHaveBeenCalledTimes(1);
  });
});

describe("getQueryBudgetContext", () => {
  it("returns undefined outside of a request context", () => {
    expect(getQueryBudgetContext()).toBeUndefined();
  });

  it("returns the context within a request", () => {
    const ctx = {
      budgetMs: 10000,
      totalSqlTimeMs: 0,
      route: "/test",
      breached: false,
    };
    runWithQueryBudget(ctx, () => {
      expect(getQueryBudgetContext()).toEqual(ctx);
    });
    expect(getQueryBudgetContext()).toBeUndefined();
  });
});
