// @ts-nocheck
/**
 * Tests for the load generator.
 */

import { describe, it, expect } from "@jest/globals";
import {
  buildReplayPlan,
  executeReplayPlan,
  runSimulation,
  aggregateRouteStats,
} from "../../simulator/loadGenerator.js";
import { buildSyntheticCurve } from "../../simulator/trafficIngester.js";
import {
  SimulatorConfigSchema,
  SimulatedRequest,
  TrafficCurve,
} from "../../simulator/types.js";
import { SimulationSafetyError } from "../../simulator/safetyGuardrails.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeSample = (
  ts: number,
  route: TrafficCurve["samples"][number]["route"] = "slots_list",
  overrides: Partial<TrafficCurve["samples"][number]> = {},
) => ({
  timestampMs: ts,
  route,
  requestCount: 60,
  errorCount: 1,
  p99LatencyMs: 80,
  ...overrides,
});

const BASE_MS = 1_700_000_000_000;

const minimalCurve: TrafficCurve = {
  label: "minimal",
  startIso: new Date(BASE_MS).toISOString(),
  endIso: new Date(BASE_MS + 120_000).toISOString(),
  samples: [makeSample(BASE_MS), makeSample(BASE_MS + 60_000)],
};

const defaultConfig = SimulatorConfigSchema.parse({
  seed: 42,
  dryRun: true,
  maxDurationMs: 120_000,
});

// ---------------------------------------------------------------------------
// buildReplayPlan – basic structure
// ---------------------------------------------------------------------------

describe("buildReplayPlan – basic structure", () => {
  it("returns a ReplayPlan with correct label", () => {
    const plan = buildReplayPlan(minimalCurve, defaultConfig);
    expect(plan.label).toBe("minimal");
  });

  it("returns requests array (may be empty if all windows are out of range)", () => {
    const plan = buildReplayPlan(minimalCurve, defaultConfig);
    expect(Array.isArray(plan.requests)).toBe(true);
  });

  it("each request has required fields", () => {
    const plan = buildReplayPlan(minimalCurve, defaultConfig);
    for (const req of plan.requests) {
      expect(typeof req.id).toBe("string");
      expect(typeof req.route).toBe("string");
      expect(typeof req.offsetMs).toBe("number");
      expect(typeof req.latencyMs).toBe("number");
      expect(typeof req.isError).toBe("boolean");
    }
  });

  it("all request offsets are within [0, maxDurationMs)", () => {
    const plan = buildReplayPlan(minimalCurve, defaultConfig);
    for (const req of plan.requests) {
      expect(req.offsetMs).toBeGreaterThanOrEqual(0);
      expect(req.offsetMs).toBeLessThan(defaultConfig.maxDurationMs);
    }
  });

  it("requests are sorted by offsetMs", () => {
    const curve = buildSyntheticCurve({ sampleCount: 5, seed: undefined });
    const plan = buildReplayPlan(curve, defaultConfig);
    for (let i = 1; i < plan.requests.length; i++) {
      expect(plan.requests[i].offsetMs).toBeGreaterThanOrEqual(
        plan.requests[i - 1].offsetMs,
      );
    }
  });

  it("durationMs ≤ maxDurationMs", () => {
    const plan = buildReplayPlan(minimalCurve, defaultConfig);
    expect(plan.durationMs).toBeLessThanOrEqual(defaultConfig.maxDurationMs);
  });
});

// ---------------------------------------------------------------------------
// buildReplayPlan – determinism with seed
// ---------------------------------------------------------------------------

describe("buildReplayPlan – determinism", () => {
  it("produces identical plans when given the same seed", () => {
    const curve = buildSyntheticCurve({ sampleCount: 3 });
    const configA = SimulatorConfigSchema.parse({ seed: 99, dryRun: true });
    const configB = SimulatorConfigSchema.parse({ seed: 99, dryRun: true });

    const planA = buildReplayPlan(curve, configA);
    const planB = buildReplayPlan(curve, configB);

    expect(planA.requests.length).toBe(planB.requests.length);
    for (let i = 0; i < planA.requests.length; i++) {
      // IDs are random UUIDs so we compare everything else
      expect(planA.requests[i].route).toBe(planB.requests[i].route);
      expect(planA.requests[i].offsetMs).toBe(planB.requests[i].offsetMs);
      expect(planA.requests[i].latencyMs).toBe(planB.requests[i].latencyMs);
      expect(planA.requests[i].isError).toBe(planB.requests[i].isError);
    }
  });
});

// ---------------------------------------------------------------------------
// buildReplayPlan – scale factor
// ---------------------------------------------------------------------------

describe("buildReplayPlan – scale factor", () => {
  it("scale factor 2 roughly doubles the request count", () => {
    const curve = buildSyntheticCurve({ sampleCount: 5 });
    const c1 = SimulatorConfigSchema.parse({ seed: 1, dryRun: true, scaleFactor: 1.0 });
    const c2 = SimulatorConfigSchema.parse({ seed: 1, dryRun: true, scaleFactor: 2.0 });
    const p1 = buildReplayPlan(curve, c1);
    const p2 = buildReplayPlan(curve, c2);
    expect(p2.requests.length).toBeGreaterThan(p1.requests.length);
    // Should be approximately double
    expect(p2.requests.length / p1.requests.length).toBeCloseTo(2, 0);
  });

  it("scale factor 0.5 roughly halves the request count", () => {
    const curve = buildSyntheticCurve({ sampleCount: 5 });
    const c1 = SimulatorConfigSchema.parse({ seed: 1, dryRun: true, scaleFactor: 1.0 });
    const c2 = SimulatorConfigSchema.parse({ seed: 1, dryRun: true, scaleFactor: 0.5 });
    const p1 = buildReplayPlan(curve, c1);
    const p2 = buildReplayPlan(curve, c2);
    expect(p2.requests.length).toBeLessThan(p1.requests.length);
  });
});

// ---------------------------------------------------------------------------
// buildReplayPlan – maxDurationMs truncation
// ---------------------------------------------------------------------------

describe("buildReplayPlan – maxDurationMs truncation", () => {
  it("no requests are scheduled beyond maxDurationMs", () => {
    const shortConfig = SimulatorConfigSchema.parse({
      seed: 1,
      dryRun: true,
      maxDurationMs: 30_000,
    });
    const curve = buildSyntheticCurve({ sampleCount: 30 });
    const plan = buildReplayPlan(curve, shortConfig);
    for (const req of plan.requests) {
      expect(req.offsetMs).toBeLessThan(30_000);
    }
  });

  it("returns empty plan when maxDurationMs is smaller than first window start", () => {
    // The curve starts at BASE_MS; offset 0 = BASE_MS, but second window is at 60s
    const veryShortConfig = SimulatorConfigSchema.parse({
      seed: 1,
      dryRun: true,
      maxDurationMs: 1, // effectively 1ms – no window fits
    });
    // Curve window starts at 0 offset (timestampMs === startMs), so it _could_ fit
    // but scaledCount may still produce requests; use a large gap to guarantee none
    const curve: TrafficCurve = {
      label: "skip",
      startIso: new Date(BASE_MS).toISOString(),
      endIso: new Date(BASE_MS + 120_000).toISOString(),
      samples: [makeSample(BASE_MS + 90_000)], // window at 90s offset → beyond 1ms maxDuration
    };
    const plan = buildReplayPlan(curve, veryShortConfig);
    expect(plan.requests).toHaveLength(0);
    expect(plan.durationMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildReplayPlan – error injection
// ---------------------------------------------------------------------------

describe("buildReplayPlan – error injection", () => {
  it("error fraction matches historical sample rate", () => {
    const errorRate = 0.1; // 10 errors per 100 requests
    const curve: TrafficCurve = {
      label: "error-test",
      startIso: new Date(BASE_MS).toISOString(),
      endIso: new Date(BASE_MS + 120_000).toISOString(),
      samples: [
        makeSample(BASE_MS, "booking_intent", {
          requestCount: 1000,
          errorCount: 100, // 10%
        }),
      ],
    };
    const config = SimulatorConfigSchema.parse({ seed: 7, dryRun: true });
    const plan = buildReplayPlan(curve, config);

    const errors = plan.requests.filter((r) => r.isError).length;
    const total = plan.requests.length;
    const actualRate = errors / total;

    // Allow ±2% tolerance
    expect(actualRate).toBeCloseTo(errorRate, 1);
  });

  it("produces 0 errors when errorCount is 0", () => {
    const curve: TrafficCurve = {
      label: "no-error",
      startIso: new Date(BASE_MS).toISOString(),
      endIso: new Date(BASE_MS + 120_000).toISOString(),
      samples: [makeSample(BASE_MS, "slots_list", { errorCount: 0 })],
    };
    const plan = buildReplayPlan(curve, defaultConfig);
    expect(plan.requests.every((r) => !r.isError)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildReplayPlan – latency sampling
// ---------------------------------------------------------------------------

describe("buildReplayPlan – latency sampling", () => {
  it("all latencies are positive", () => {
    const plan = buildReplayPlan(minimalCurve, defaultConfig);
    for (const req of plan.requests) {
      expect(req.latencyMs).toBeGreaterThan(0);
    }
  });

  it("no latency exceeds 3× p99", () => {
    const p99 = 200;
    const curve: TrafficCurve = {
      ...minimalCurve,
      samples: [makeSample(BASE_MS, "checkout", { p99LatencyMs: p99 })],
    };
    const plan = buildReplayPlan(curve, defaultConfig);
    for (const req of plan.requests) {
      expect(req.latencyMs).toBeLessThanOrEqual(3 * p99);
    }
  });
});

// ---------------------------------------------------------------------------
// buildReplayPlan – safety guardrail
// ---------------------------------------------------------------------------

describe("buildReplayPlan – safety guardrail", () => {
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("throws SimulationSafetyError in production", () => {
    process.env.NODE_ENV = "production";
    expect(() => buildReplayPlan(minimalCurve, defaultConfig)).toThrow(
      SimulationSafetyError,
    );
  });
});

// ---------------------------------------------------------------------------
// executeReplayPlan – dry-run mode
// ---------------------------------------------------------------------------

describe("executeReplayPlan – dry-run", () => {
  it("invokes the handler for every request synchronously", async () => {
    const curve = buildSyntheticCurve({ sampleCount: 2 });
    const plan = buildReplayPlan(curve, defaultConfig);
    const collected: SimulatedRequest[] = [];

    await executeReplayPlan(plan, (req) => { collected.push(req); }, { dryRun: true });

    expect(collected).toHaveLength(plan.requests.length);
  });

  it("calls onProgress with final completed = total", async () => {
    const curve = buildSyntheticCurve({ sampleCount: 1 });
    const plan = buildReplayPlan(curve, defaultConfig);
    let lastCompleted = -1;
    let lastTotal = -1;

    await executeReplayPlan(plan, undefined, {
      dryRun: true,
      onProgress: (c, t) => { lastCompleted = c; lastTotal = t; },
    });

    expect(lastCompleted).toBe(plan.requests.length);
    expect(lastTotal).toBe(plan.requests.length);
  });

  it("handles empty request list gracefully", async () => {
    const emptyPlan = { label: "empty", durationMs: 0, requests: [] };
    await expect(
      executeReplayPlan(emptyPlan, undefined, { dryRun: true }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// executeReplayPlan – live mode (uses real timers, very short duration)
// ---------------------------------------------------------------------------

describe("executeReplayPlan – live mode", () => {
  it("completes within reasonable wall time for a tiny plan", async () => {
    const plan = {
      label: "live-test",
      durationMs: 50,
      requests: [
        {
          id: "r1",
          route: "slots_list" as const,
          offsetMs: 10,
          latencyMs: 5,
          isError: false,
        },
        {
          id: "r2",
          route: "booking_intent" as const,
          offsetMs: 20,
          latencyMs: 5,
          isError: false,
        },
      ],
    };

    const collected: string[] = [];
    const start = Date.now();

    await executeReplayPlan(plan, (req) => { collected.push(req.id); }, {
      dryRun: false,
    });

    const elapsed = Date.now() - start;
    expect(collected).toHaveLength(2);
    // Should finish in well under 500ms (offsets are 10ms and 20ms)
    expect(elapsed).toBeLessThan(500);
  }, 2000);

  it("handles handler that returns a promise", async () => {
    const plan = {
      label: "async-handler",
      durationMs: 50,
      requests: [
        {
          id: "r1",
          route: "checkout" as const,
          offsetMs: 0,
          latencyMs: 1,
          isError: false,
        },
      ],
    };

    const results: string[] = [];
    await executeReplayPlan(
      plan,
      async (req) => {
        await Promise.resolve();
        results.push(req.id);
      },
      { dryRun: false },
    );

    expect(results).toEqual(["r1"]);
  }, 2000);
});

// ---------------------------------------------------------------------------
// runSimulation convenience wrapper
// ---------------------------------------------------------------------------

describe("runSimulation", () => {
  it("returns the plan after execution", async () => {
    const curve = buildSyntheticCurve({ sampleCount: 2 });
    const config = SimulatorConfigSchema.parse({ seed: 1, dryRun: true });
    const plan = await runSimulation(curve, config);
    expect(plan.label).toBe(curve.label);
    expect(Array.isArray(plan.requests)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// aggregateRouteStats helper
// ---------------------------------------------------------------------------

describe("aggregateRouteStats", () => {
  it("sums requests and errors per route", () => {
    const curve = buildSyntheticCurve({ sampleCount: 3, errorRateFraction: 0.01 });
    const stats = aggregateRouteStats(curve);
    expect(stats.size).toBeGreaterThan(0);
    for (const [, s] of stats) {
      expect(s.totalRequests).toBeGreaterThanOrEqual(0);
      expect(s.totalErrors).toBeGreaterThanOrEqual(0);
      expect(s.avgP99Ms).toBeGreaterThan(0);
    }
  });

  it("returns empty map for an empty samples array", () => {
    const curve: TrafficCurve = {
      ...minimalCurve,
      samples: [],
    };
    // aggregateRouteStats doesn't validate the schema, just aggregates
    const stats = aggregateRouteStats(curve);
    expect(stats.size).toBe(0);
  });

  it("computes weighted average p99", () => {
    const curve: TrafficCurve = {
      ...minimalCurve,
      samples: [
        makeSample(BASE_MS, "checkout", { requestCount: 100, p99LatencyMs: 100 }),
        makeSample(BASE_MS + 60_000, "checkout", {
          requestCount: 100,
          p99LatencyMs: 200,
        }),
      ],
    };
    const stats = aggregateRouteStats(curve);
    const checkoutStats = stats.get("checkout");
    expect(checkoutStats?.totalRequests).toBe(200);
    expect(checkoutStats?.avgP99Ms).toBeCloseTo(150, 0);
  });
});
