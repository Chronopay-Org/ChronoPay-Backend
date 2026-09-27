/**
 * quotaEnforcement.test.ts
 *
 * Focused behaviour coverage for the enforceQuota middleware.
 *
 * Strategy: mock `checkAndConsume` (the quota service) and `getPool` (the DB
 * connection) so the middleware can be exercised in full isolation — no DB, no
 * Redis, no Prometheus side-effects.
 *
 * Cases covered:
 *  1. Missing apiKeyId  → skips enforcement and calls next()
 *  2. Daily limit exceeded → 429 with quota payload and "daily" message
 *  3. Monthly limit exceeded → 429 with quota payload and "monthly" message
 *  4. Both limits exceeded → 429 (daily reported in message)
 *  5. Allowed request  → calls next() and sets X-Quota-* response headers
 *  6. Service error (checkAndConsume throws) → fail-open, calls next()
 *  7. next() is NOT called when quota is exceeded (no double-call)
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { Request, Response, NextFunction } from "express";

// ─── Minimal mock helpers ─────────────────────────────────────────────────────

/** Minimal stub that satisfies the Express Response interface for these tests. */
function makeRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    _headers: headers,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
  };
  return res as unknown as Response & {
    statusCode: number;
    body: unknown;
    _headers: Record<string, string>;
  };
}

/** Build a minimal Request-like object with an optional apiKeyId. */
function makeReq(apiKeyId?: string): Request {
  return { apiKeyId } as unknown as Request;
}

// ─── Module-level mocks (hoisted before imports) ──────────────────────────────

// Mock getPool so SqlQuotaStore constructor does not reach a real database.
const mockPool = { query: jest.fn() };

jest.unstable_mockModule("../../db/connection.js", () => ({
  getPool: jest.fn(() => mockPool),
}));

// Mock the quota service – we control what checkAndConsume returns per test.
const mockCheckAndConsume = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule("../../services/partnerQuotaService.js", () => ({
  checkAndConsume: mockCheckAndConsume,
  // SqlQuotaStore is newed-up inside enforceQuota; provide a trivial class.
  SqlQuotaStore: jest.fn().mockImplementation(() => ({})),
}));

// Mock logger to prevent log noise and allow assertion on error logging.
const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };

jest.unstable_mockModule("../../utils/logger.js", () => ({
  logger: mockLogger,
}));

// ─── Import SUT after mocks are registered ────────────────────────────────────

const { enforceQuota } = await import("../quotaEnforcement.js");

// ─── Shared quota result builders ─────────────────────────────────────────────

function allowedResult(overrides: Partial<ReturnType<typeof baseStatus>> = {}) {
  return {
    allowed: true,
    exceeded: null,
    status: { ...baseStatus(), ...overrides },
  };
}

function exceededResult(exceeded: "daily" | "monthly" | "both") {
  return {
    allowed: false,
    exceeded,
    status: baseStatus(),
  };
}

function baseStatus() {
  return {
    dailyUsed: 50,
    dailyLimit: 10000,
    monthlyUsed: 500,
    monthlyLimit: 300000,
    dailyResetAt: "2026-09-28T00:00:00.000Z",
    monthlyResetAt: "2026-10-01T00:00:00.000Z",
    tokenId: "tok_test",
    timezone: "UTC",
    dailyPercentUsed: 0.5,
    monthlyPercentUsed: 0.17,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("enforceQuota middleware", () => {
  let next: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    next = jest.fn() as unknown as NextFunction;
  });

  // ── 1. No apiKeyId → skip silently ──────────────────────────────────────

  describe("when req.apiKeyId is absent", () => {
    it("calls next() without touching the quota service", async () => {
      const req = makeReq(); // apiKeyId undefined
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(mockCheckAndConsume).not.toHaveBeenCalled();
    });

    it("does not set any X-Quota-* headers", async () => {
      const req = makeReq();
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(res._headers).not.toHaveProperty("x-quota-daily-limit");
      expect(res._headers).not.toHaveProperty("x-quota-monthly-limit");
    });

    it("does not respond with 4xx when no apiKeyId is present", async () => {
      const req = makeReq();
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(res.statusCode).toBe(200); // unchanged default
    });
  });

  // ── 2. Daily limit exceeded → 429 ───────────────────────────────────────

  describe("when daily quota is exceeded", () => {
    beforeEach(() => {
      mockCheckAndConsume.mockResolvedValue(exceededResult("daily"));
    });

    it("responds with HTTP 429", async () => {
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(res.statusCode).toBe(429);
    });

    it("includes 'daily' in the error message", async () => {
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect((res.body as Record<string, unknown>).error).toMatch(/daily/i);
    });

    it("returns success:false in the body", async () => {
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect((res.body as Record<string, unknown>).success).toBe(false);
    });

    it("includes quota data in the response body", async () => {
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      const body = res.body as Record<string, unknown>;
      expect(body.data).toMatchObject({
        dailyUsed: 50,
        dailyLimit: 10000,
        monthlyUsed: 500,
        monthlyLimit: 300000,
      });
    });

    it("does NOT call next() when quota is exceeded", async () => {
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(next).not.toHaveBeenCalled();
    });
  });

  // ── 3. Monthly limit exceeded → 429 ─────────────────────────────────────

  describe("when monthly quota is exceeded", () => {
    beforeEach(() => {
      mockCheckAndConsume.mockResolvedValue(exceededResult("monthly"));
    });

    it("responds with HTTP 429", async () => {
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(res.statusCode).toBe(429);
    });

    it("includes 'monthly' in the error message", async () => {
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect((res.body as Record<string, unknown>).error).toMatch(/monthly/i);
    });

    it("does NOT call next()", async () => {
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(next).not.toHaveBeenCalled();
    });
  });

  // ── 4. Both limits exceeded ───────────────────────────────────────────────

  describe("when both daily and monthly quota are exceeded", () => {
    beforeEach(() => {
      mockCheckAndConsume.mockResolvedValue(exceededResult("both"));
    });

    it("responds with HTTP 429", async () => {
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(res.statusCode).toBe(429);
    });

    it("does NOT call next()", async () => {
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(next).not.toHaveBeenCalled();
    });

    it("reports 'monthly' in the error message (exceeded==='both' falls to else branch)", async () => {
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      // exceeded==="both" is not strictly "daily", so the ternary
      // `result.exceeded === "daily" ? "daily" : "monthly"` resolves to "monthly".
      expect((res.body as Record<string, unknown>).error).toMatch(/monthly/i);
    });
  });

  // ── 5. Allowed request → headers and next() ──────────────────────────────

  describe("when request is within quota", () => {
    beforeEach(() => {
      mockCheckAndConsume.mockResolvedValue(allowedResult());
    });

    it("calls next() exactly once", async () => {
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it("does not change the response status", async () => {
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(res.statusCode).toBe(200);
    });

    it("sets X-Quota-Daily-Limit header", async () => {
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(res._headers["x-quota-daily-limit"]).toBe("10000");
    });

    it("sets X-Quota-Daily-Used header", async () => {
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(res._headers["x-quota-daily-used"]).toBe("50");
    });

    it("sets X-Quota-Monthly-Limit header", async () => {
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(res._headers["x-quota-monthly-limit"]).toBe("300000");
    });

    it("sets X-Quota-Monthly-Used header", async () => {
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(res._headers["x-quota-monthly-used"]).toBe("500");
    });

    it("passes the token id to checkAndConsume", async () => {
      const req = makeReq("tok_partner_42");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(mockCheckAndConsume).toHaveBeenCalledWith(
        "tok_partner_42",
        expect.anything(),
      );
    });
  });

  // ── 6. Fail-open on service error ────────────────────────────────────────

  describe("when checkAndConsume throws an error", () => {
    beforeEach(() => {
      mockCheckAndConsume.mockRejectedValue(new Error("DB connection lost"));
    });

    it("calls next() (fail-open behaviour)", async () => {
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it("does not return a 4xx or 5xx response to the caller", async () => {
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(res.statusCode).toBe(200);
    });

    it("logs the error via logger.error", async () => {
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(mockLogger.error).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("[quota-enforcement]"),
        expect.stringContaining("DB connection lost"),
      );
    });

    it("handles non-Error thrown values gracefully", async () => {
      mockCheckAndConsume.mockRejectedValue("string error thrown");
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("[quota-enforcement]"),
        "string error thrown",
      );
    });
  });

  // ── 7. Header values are stringified numbers ─────────────────────────────

  describe("header value format", () => {
    it("header values are strings, not numbers", async () => {
      mockCheckAndConsume.mockResolvedValue(
        allowedResult({ dailyLimit: 5000, dailyUsed: 123, monthlyLimit: 100000, monthlyUsed: 999 }),
      );
      const req = makeReq("tok_hdr");
      const res = makeRes();

      await enforceQuota(req, res, next);

      // setHeader receives strings (String(number)) not raw numbers
      expect(typeof res._headers["x-quota-daily-limit"]).toBe("string");
      expect(typeof res._headers["x-quota-daily-used"]).toBe("string");
      expect(typeof res._headers["x-quota-monthly-limit"]).toBe("string");
      expect(typeof res._headers["x-quota-monthly-used"]).toBe("string");
    });

    it("header values reflect the result status", async () => {
      mockCheckAndConsume.mockResolvedValue(
        allowedResult({ dailyLimit: 5000, dailyUsed: 123, monthlyLimit: 100000, monthlyUsed: 999 }),
      );
      const req = makeReq("tok_hdr");
      const res = makeRes();

      await enforceQuota(req, res, next);

      expect(res._headers["x-quota-daily-limit"]).toBe("5000");
      expect(res._headers["x-quota-daily-used"]).toBe("123");
      expect(res._headers["x-quota-monthly-limit"]).toBe("100000");
      expect(res._headers["x-quota-monthly-used"]).toBe("999");
    });
  });

  // ── 8. Response body shape for 429 ───────────────────────────────────────

  describe("429 response body contract", () => {
    it("daily exceeded body includes dailyResetAt and monthlyResetAt", async () => {
      mockCheckAndConsume.mockResolvedValue(exceededResult("daily"));
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      const data = (res.body as Record<string, unknown>).data as Record<string, unknown>;
      expect(data).toHaveProperty("dailyResetAt");
      expect(data).toHaveProperty("monthlyResetAt");
    });

    it("monthly exceeded body includes dailyResetAt and monthlyResetAt", async () => {
      mockCheckAndConsume.mockResolvedValue(exceededResult("monthly"));
      const req = makeReq("tok_test");
      const res = makeRes();

      await enforceQuota(req, res, next);

      const data = (res.body as Record<string, unknown>).data as Record<string, unknown>;
      expect(data).toHaveProperty("dailyResetAt");
      expect(data).toHaveProperty("monthlyResetAt");
    });
  });
});
