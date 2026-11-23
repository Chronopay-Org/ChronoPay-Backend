// @ts-nocheck
/**
 * quotaEnforcement.test.ts
 *
 * Focused unit tests for the enforceQuota middleware.
 *
 * Strategy:
 *  - Mock all external dependencies (checkAndConsume, SqlQuotaStore,
 *    getPool, logger) using jest.unstable_mockModule so the tests work
 *    under Jest's experimental ESM support.
 *  - Exercise every branch documented in quotaEnforcement.ts:
 *      1. No apiKeyId  → passes through silently (next() called, no 429)
 *      2. Allowed      → quota headers attached + next()
 *      3. Blocked daily  → 429 with daily error message
 *      4. Blocked monthly → 429 with monthly error message
 *      5. checkAndConsume throws → fail-open (next() called), error logged
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import type { Request, Response, NextFunction } from "express";

// ─── Shared mock state (mutated per test in beforeEach) ───────────────────────

const mockCheckAndConsume = jest.fn();
const mockGetPool = jest.fn();
const mockLoggerError = jest.fn();

// SqlQuotaStore constructor — we capture the args to verify pool is passed in
let lastStoreArg: unknown = undefined;

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.unstable_mockModule("../../services/partnerQuotaService.js", () => ({
  checkAndConsume: mockCheckAndConsume,
  SqlQuotaStore: function (pool: unknown) {
    lastStoreArg = pool;
    return {}; // return a plain object as the store
  },
}));

jest.unstable_mockModule("../../db/connection.js", () => ({
  getPool: mockGetPool,
}));

jest.unstable_mockModule("../../utils/logger.js", () => ({
  logger: {
    error: mockLoggerError,
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

// Dynamic import so the mocks are resolved first
const { enforceQuota } = await import("../quotaEnforcement.js");

// ─── Shared fixture builders ──────────────────────────────────────────────────

const BASE_STATUS = {
  tokenId: "tok_test",
  dailyUsed: 1,
  dailyLimit: 10000,
  monthlyUsed: 1,
  monthlyLimit: 300000,
  dailyResetAt: "2026-09-28T00:00:00.000Z",
  monthlyResetAt: "2026-10-01T00:00:00.000Z",
  timezone: "UTC",
  dailyPercentUsed: 0.01,
  monthlyPercentUsed: 0,
};

function makeAllowedResult(overrides: Record<string, unknown> = {}) {
  return {
    allowed: true,
    exceeded: null,
    status: { ...BASE_STATUS, ...overrides },
  };
}

function makeBlockedResult(exceeded: "daily" | "monthly" | "both", statusOverrides: Record<string, unknown> = {}) {
  return {
    allowed: false,
    exceeded,
    status: { ...BASE_STATUS, ...statusOverrides },
  };
}

function makeReq(apiKeyId?: string): Partial<Request> {
  return { apiKeyId } as Partial<Request>;
}

function makeRes() {
  const headers: Record<string, string> = {};
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockImplementation((key: string, value: string) => {
      headers[key] = value;
    }),
    _headers: headers,
  };
  return res;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("enforceQuota middleware", () => {
  let next: NextFunction;
  const fakePool = { _fake: "pool" };

  beforeEach(() => {
    next = jest.fn();
    lastStoreArg = undefined;
    mockGetPool.mockReturnValue(fakePool);
    mockCheckAndConsume.mockResolvedValue(makeAllowedResult());
    mockLoggerError.mockReset();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── Branch 1: no apiKeyId ──────────────────────────────────────────────────

  describe("when req.apiKeyId is absent", () => {
    it("calls next() without touching checkAndConsume", async () => {
      const req = makeReq(undefined);
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith(); // called with no error argument
      expect(mockCheckAndConsume).not.toHaveBeenCalled();
    });

    it("does not send any response when apiKeyId is absent", async () => {
      const req = makeReq(undefined);
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it("handles null apiKeyId the same as undefined (falsy bypass)", async () => {
      const req = makeReq(null as any);
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith();
      expect(mockCheckAndConsume).not.toHaveBeenCalled();
    });

    it("treats empty-string apiKeyId as absent (falsy bypass)", async () => {
      const req = makeReq("" as any);
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith();
      expect(mockCheckAndConsume).not.toHaveBeenCalled();
    });
  });

  // ── Branch 2: request allowed ─────────────────────────────────────────────

  describe("when checkAndConsume returns allowed = true", () => {
    it("calls next() with no arguments", async () => {
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
    });

    it("does not send a 429 response when allowed", async () => {
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(res.status).not.toHaveBeenCalledWith(429);
      expect(res.json).not.toHaveBeenCalled();
    });

    it("attaches X-Quota-Daily-Limit header with string value", async () => {
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(res.setHeader).toHaveBeenCalledWith("X-Quota-Daily-Limit", "10000");
    });

    it("attaches X-Quota-Daily-Used header reflecting current usage", async () => {
      mockCheckAndConsume.mockResolvedValue(makeAllowedResult({ dailyUsed: 42 }));
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(res.setHeader).toHaveBeenCalledWith("X-Quota-Daily-Used", "42");
    });

    it("attaches X-Quota-Monthly-Limit header with string value", async () => {
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(res.setHeader).toHaveBeenCalledWith("X-Quota-Monthly-Limit", "300000");
    });

    it("attaches X-Quota-Monthly-Used header reflecting current usage", async () => {
      mockCheckAndConsume.mockResolvedValue(makeAllowedResult({ monthlyUsed: 99 }));
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(res.setHeader).toHaveBeenCalledWith("X-Quota-Monthly-Used", "99");
    });

    it("all four header values are strings (not numbers)", async () => {
      mockCheckAndConsume.mockResolvedValue(
        makeAllowedResult({ dailyLimit: 500, dailyUsed: 7, monthlyLimit: 15000, monthlyUsed: 200 }),
      );
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      for (const call of (res.setHeader as jest.Mock).mock.calls) {
        expect(typeof call[1]).toBe("string");
      }
    });

    it("passes the correct tokenId to checkAndConsume", async () => {
      const req = makeReq("tok_xyz");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(mockCheckAndConsume).toHaveBeenCalledWith("tok_xyz", expect.anything());
    });

    it("constructs a SqlQuotaStore from the pool returned by getPool()", async () => {
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(mockGetPool).toHaveBeenCalled();
      expect(lastStoreArg).toBe(fakePool);
    });
  });

  // ── Branch 3: daily quota exceeded ────────────────────────────────────────

  describe("when daily quota is exceeded", () => {
    beforeEach(() => {
      mockCheckAndConsume.mockResolvedValue(
        makeBlockedResult("daily", { dailyUsed: 10000, dailyLimit: 10000 }),
      );
    });

    it("responds with HTTP 429", async () => {
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(429);
    });

    it("sets success: false in the response body", async () => {
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    });

    it("includes 'daily' in the error message", async () => {
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.error).toMatch(/daily/i);
    });

    it("embeds quota status data (dailyUsed, dailyLimit, monthlyUsed, etc.) in response", async () => {
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.data).toMatchObject({
        dailyUsed: 10000,
        dailyLimit: 10000,
        monthlyUsed: expect.any(Number),
        monthlyLimit: expect.any(Number),
        dailyResetAt: expect.any(String),
        monthlyResetAt: expect.any(String),
      });
    });

    it("does not call next() when daily quota is blocked", async () => {
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
    });

    it("does not attach quota headers when request is blocked", async () => {
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(res.setHeader).not.toHaveBeenCalled();
    });
  });

  // ── Branch 4: monthly quota exceeded ──────────────────────────────────────

  describe("when monthly quota is exceeded", () => {
    beforeEach(() => {
      mockCheckAndConsume.mockResolvedValue(
        makeBlockedResult("monthly", { monthlyUsed: 300000, monthlyLimit: 300000 }),
      );
    });

    it("responds with HTTP 429", async () => {
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(429);
    });

    it("includes 'monthly' in the error message", async () => {
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.error).toMatch(/monthly/i);
    });

    it("embeds monthly quota status data in the response", async () => {
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.data).toMatchObject({
        monthlyUsed: 300000,
        monthlyLimit: 300000,
      });
    });

    it("does not call next() when monthly quota is blocked", async () => {
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
    });
  });

  // ── Branch 5: checkAndConsume throws (fail-open) ──────────────────────────

  describe("when checkAndConsume throws an error", () => {
    it("calls next() to fail open so the request is not dropped", async () => {
      mockCheckAndConsume.mockRejectedValue(new Error("DB connection lost"));
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
    });

    it("does not send any HTTP response when failing open", async () => {
      mockCheckAndConsume.mockRejectedValue(new Error("DB connection lost"));
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it("calls logger.error once with a quota-related context string", async () => {
      mockCheckAndConsume.mockRejectedValue(new Error("timeout"));
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(mockLoggerError).toHaveBeenCalledTimes(1);
      const firstArg = mockLoggerError.mock.calls[0][0];
      expect(firstArg).toMatch(/quota/i);
    });

    it("logs the Error message as the second argument to logger.error", async () => {
      mockCheckAndConsume.mockRejectedValue(new Error("ECONNREFUSED"));
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      const secondArg = mockLoggerError.mock.calls[0][1];
      expect(secondArg).toContain("ECONNREFUSED");
    });

    it("handles non-Error throws (string) gracefully — still fails open", async () => {
      mockCheckAndConsume.mockRejectedValue("quota store unavailable");
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith();
      expect(mockLoggerError).toHaveBeenCalled();
    });

    it("logs the stringified value when a non-Error is thrown", async () => {
      mockCheckAndConsume.mockRejectedValue("quota store unavailable");
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      const secondArg = mockLoggerError.mock.calls[0][1];
      expect(secondArg).toBe("quota store unavailable");
    });
  });

  // ── Boundary / edge cases ─────────────────────────────────────────────────

  describe("boundary and edge cases", () => {
    it("treats exceeded = 'both' as 'monthly' (source uses ternary: !== 'daily' → monthly)", async () => {
      mockCheckAndConsume.mockResolvedValue({
        allowed: false,
        exceeded: "both",
        status: { ...BASE_STATUS },
      });
      const req = makeReq("tok_abc");
      const res = makeRes();

      await enforceQuota(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(429);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.error).toMatch(/monthly/i);
    });

    it("returns a Promise (middleware is async)", () => {
      const req = makeReq("tok_abc");
      const res = makeRes();

      const result = enforceQuota(req as Request, res as Response, next);

      expect(result).toBeInstanceOf(Promise);
    });

    it("works correctly with different token IDs in the same test session", async () => {
      const tokens = ["tok_a", "tok_b", "tok_c"];
      for (const token of tokens) {
        jest.clearAllMocks();
        mockGetPool.mockReturnValue(fakePool);
        mockCheckAndConsume.mockResolvedValue(makeAllowedResult());
        const req = makeReq(token);
        const res = makeRes();

        await enforceQuota(req as Request, res as Response, next);

        expect(mockCheckAndConsume).toHaveBeenCalledWith(token, expect.anything());
        expect(next).toHaveBeenCalledWith();
      }
    });
  });
});
