/**
 * Tests for instrumentQuery() in src/db/connection.ts
 *
 * Uses _setSlowQueryThreshold() to control the threshold without touching
 * process.env, and imports metrics directly to assert counter/histogram state.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { instrumentQuery, _setSlowQueryThreshold } from "../../db/connection.js";
import { slowQueryCounter, slowQueryDuration } from "../../metrics.js";
import { logger } from "../../utils/logger.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Cast to the mock shape so we can read internal state. */
const counter = slowQueryCounter as unknown as { hashMap: Record<string, { value: number }> };
const histogram = slowQueryDuration as unknown as { observations: number[] };

function counterValue(): number {
  return counter.hashMap[""].value;
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  // Reset metrics state between tests
  counter.hashMap[""].value = 0;
  histogram.observations = [];
  // Disable threshold by default; each test opts in
  _setSlowQueryThreshold(null);
});

afterEach(() => {
  _setSlowQueryThreshold(null);
  jest.restoreAllMocks();
});

// ─── Threshold disabled ───────────────────────────────────────────────────────

describe("instrumentQuery — threshold disabled (null)", () => {
  it("returns the value from execute()", async () => {
    const result = await instrumentQuery("SELECT 1", () => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("does not increment the slow-query counter", async () => {
    await instrumentQuery("SELECT 1", () => Promise.resolve(null));
    expect(counterValue()).toBe(0);
  });

  it("does not record a histogram observation", async () => {
    await instrumentQuery("SELECT 1", () => Promise.resolve(null));
    expect(histogram.observations).toHaveLength(0);
  });

  it("does not emit a warn log", async () => {
    const warnSpy = jest.spyOn(logger, "warn");
    await instrumentQuery("SELECT 1", () => Promise.resolve(null));
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ─── Fast query (below threshold) ────────────────────────────────────────────

describe("instrumentQuery — fast query (below threshold)", () => {
  beforeEach(() => {
    _setSlowQueryThreshold(10_000); // 10 s — no real query will hit this
  });

  it("returns the value from execute()", async () => {
    const result = await instrumentQuery("SELECT 1", () => Promise.resolve("fast"));
    expect(result).toBe("fast");
  });

  it("does not increment the slow-query counter", async () => {
    await instrumentQuery("SELECT 1", () => Promise.resolve(null));
    expect(counterValue()).toBe(0);
  });

  it("does not record a histogram observation", async () => {
    await instrumentQuery("SELECT 1", () => Promise.resolve(null));
    expect(histogram.observations).toHaveLength(0);
  });
});

// ─── Slow query (at or above threshold) ──────────────────────────────────────

describe("instrumentQuery — slow query (exceeds threshold)", () => {
  beforeEach(() => {
    _setSlowQueryThreshold(1); // 1 ms — any real async call will exceed this
  });

  it("returns the value from execute() even when slow", async () => {
    const result = await instrumentQuery("SELECT pg_sleep(0)", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "done";
    });
    expect(result).toBe("done");
  });

  it("increments the slow-query counter", async () => {
    await instrumentQuery("SELECT pg_sleep(0)", async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(counterValue()).toBe(1);
  });

  it("records a histogram observation with the elapsed duration", async () => {
    await instrumentQuery("SELECT pg_sleep(0)", async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(histogram.observations).toHaveLength(1);
    expect(histogram.observations[0]).toBeGreaterThanOrEqual(1);
  });

  it("emits a warn log with query text, duration, and threshold — no params", async () => {
    const warnSpy = jest.spyOn(logger, "warn");
    await instrumentQuery("SELECT pg_sleep(0)", async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [context, message] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toMatch(/slow query/i);
    expect(context).toMatchObject({
      query: "SELECT pg_sleep(0)",
      threshold: 1,
    });
    expect(context.durationMs).toBeGreaterThanOrEqual(1);
    // Params must never appear in the log context
    expect(context).not.toHaveProperty("params");
  });

  it("accumulates counter across multiple slow queries", async () => {
    for (let i = 0; i < 3; i++) {
      await instrumentQuery("SELECT 1", async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    }
    expect(counterValue()).toBe(3);
  });
});

// ─── Error propagation ────────────────────────────────────────────────────────

describe("instrumentQuery — error propagation", () => {
  it("re-throws errors from execute()", async () => {
    const boom = new Error("query failed");
    await expect(
      instrumentQuery("SELECT 1", () => Promise.reject(boom)),
    ).rejects.toThrow("query failed");
  });

  it("still records slow-query metrics when execute() throws after delay", async () => {
    _setSlowQueryThreshold(1);
    const boom = new Error("timeout");
    await expect(
      instrumentQuery("SELECT 1", async () => {
        await new Promise((r) => setTimeout(r, 5));
        throw boom;
      }),
    ).rejects.toThrow("timeout");
    expect(counterValue()).toBe(1);
    expect(histogram.observations).toHaveLength(1);
  });

  it("does not record metrics when execute() throws immediately (fast fail)", async () => {
    _setSlowQueryThreshold(10_000);
    await expect(
      instrumentQuery("SELECT 1", () => Promise.reject(new Error("fast fail"))),
    ).rejects.toThrow("fast fail");
    expect(counterValue()).toBe(0);
  });
});
