/**
 * Integration tests for the full capacity simulation pipeline.
 *
 * Covers the complete flow: ingest → plan → execute → report
 * and edge cases (missing range, network-drop mid-run, unrealistic mix).
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  simulate,
  buildSyntheticCurve,
  ingestFromObject,
  SimulationSafetyError,
} from "../../simulator/index.js";
import type { TrafficCurve } from "../../simulator/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_MS = 1_700_000_000_000;

const makeSample = (
  ts: number,
  route: TrafficCurve["samples"][number]["route"] = "slots_list",
  overrides: Partial<TrafficCurve["samples"][number]> = {},
) => ({
  timestampMs: ts,
  route,
  requestCount: 100,
  errorCount: 1,
  p99LatencyMs: 80,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Happy path: full simulation pipeline
// ---------------------------------------------------------------------------

describe("simulate() – happy path", () => {
  it("returns a SimulateResult with all required fields", async () => {
    const curve = buildSyntheticCurve({ sampleCount: 5, peakRps: 10 });
    const result = await simulate({
      curve,
      config: { seed: 1, dryRun: true, scaleFactor: 1.0 },
    });

    expect(result.curve.label).toBe(curve.label);
    expect(result.plan).toBeDefined();
    expect(result.report).toBeDefined();
    expect(result.formattedReport).toContain(curve.label);
    expect(Array.isArray(result.ingestionWarnings)).toBe(true);
  });

  it("returns allWithinBudget=true for a healthy curve", async () => {
    const curve = buildSyntheticCurve({
      sampleCount: 5,
      peakRps: 20,
      errorRateFraction: 0.00001,
    });
    const result = await simulate({ curve, config: { seed: 2, dryRun: true } });
    expect(result.report.allWithinBudget).toBe(true);
  });

  it("returns allWithinBudget=false for a curve with 20% errors", async () => {
    const curve = buildSyntheticCurve({
      sampleCount: 5,
      errorRateFraction: 0.2,
    });
    const result = await simulate({ curve, config: { seed: 3, dryRun: true } });
    expect(result.report.allWithinBudget).toBe(false);
  });

  it("uses synthetic curve when no curve or curveFile provided", async () => {
    const result = await simulate({ config: { dryRun: true } });
    expect(result.curve).toBeDefined();
    expect(result.plan).toBeDefined();
    expect(result.report).toBeDefined();
  });

  it("respects scale factor", async () => {
    const curve = buildSyntheticCurve({ sampleCount: 3 });
    const r1 = await simulate({ curve, config: { seed: 5, dryRun: true, scaleFactor: 1.0 } });
    const r2 = await simulate({ curve, config: { seed: 5, dryRun: true, scaleFactor: 2.0 } });
    expect(r2.report.totalRequests).toBeGreaterThan(r1.report.totalRequests);
  });

  it("calls requestHandler for every request in the plan", async () => {
    const curve = buildSyntheticCurve({ sampleCount: 2 });
    const handledIds = new Set<string>();
    const result = await simulate({
      curve,
      config: { seed: 6, dryRun: true },
      requestHandler: (req) => { handledIds.add(req.id); },
    });
    expect(handledIds.size).toBe(result.plan.requests.length);
  });

  it("invokes onProgress callback", async () => {
    const curve = buildSyntheticCurve({ sampleCount: 2 });
    let lastDone = -1;
    let lastTotal = -1;
    await simulate({
      curve,
      config: { seed: 7, dryRun: true },
      onProgress: (done, total) => { lastDone = done; lastTotal = total; },
    });
    expect(lastDone).toBeGreaterThan(0);
    expect(lastTotal).toBeGreaterThan(0);
    expect(lastDone).toBe(lastTotal);
  });
});

// ---------------------------------------------------------------------------
// Edge case: missing historical range
// ---------------------------------------------------------------------------

describe("simulate() – missing historical range", () => {
  it("emits SPARSE_RANGE warning for large gaps in sample data", async () => {
    // Normal samples at 60s intervals, then a huge 10-minute gap
    const samples = [
      makeSample(BASE_MS, "slots_list"),
      makeSample(BASE_MS + 60_000, "slots_list"),
      makeSample(BASE_MS + 120_000, "slots_list"),
      makeSample(BASE_MS + 720_000, "slots_list"), // 10-min gap
    ];
    const curve: TrafficCurve = {
      label: "sparse",
      startIso: new Date(BASE_MS).toISOString(),
      endIso: new Date(BASE_MS + 800_000).toISOString(),
      samples,
    };

    const result = await simulate({
      curve,
      config: { dryRun: true, maxDurationMs: 800_000 },
    });

    const sparseWarning = result.ingestionWarnings.find(
      (w) => w.code === "SPARSE_RANGE",
    );
    expect(sparseWarning).toBeDefined();
  });

  it("still produces a valid plan even with a sparse curve", async () => {
    const samples = [
      makeSample(BASE_MS, "booking_intent"),
      makeSample(BASE_MS + 3_600_000, "booking_intent"), // 1-hour gap
    ];
    const curve: TrafficCurve = {
      label: "sparse-big",
      startIso: new Date(BASE_MS).toISOString(),
      endIso: new Date(BASE_MS + 3_700_000).toISOString(),
      samples,
    };

    const result = await simulate({
      curve,
      config: { dryRun: true, maxDurationMs: 3_700_000 },
    });

    expect(result.plan).toBeDefined();
    expect(result.report).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Edge case: unrealistic traffic mix
// ---------------------------------------------------------------------------

describe("simulate() – unrealistic traffic mix", () => {
  it("handles 100% error rate without crashing", async () => {
    const curve = buildSyntheticCurve({
      sampleCount: 3,
      errorRateFraction: 1.0,
    });
    const result = await simulate({
      curve,
      config: { seed: 8, dryRun: true },
    });
    expect(result.report.allWithinBudget).toBe(false);
  });

  it("handles 0% error rate (all-success)", async () => {
    const curve = buildSyntheticCurve({
      sampleCount: 3,
      errorRateFraction: 0,
    });
    const result = await simulate({
      curve,
      config: { seed: 9, dryRun: true },
    });
    expect(result.report.allWithinBudget).toBe(true);
  });

  it("handles very high request count without running out of memory", async () => {
    // Large scale – should complete without issue
    const curve = buildSyntheticCurve({ sampleCount: 5, peakRps: 1000 });
    const result = await simulate({
      curve,
      config: { seed: 10, dryRun: true, scaleFactor: 1.0 },
    });
    expect(result.plan.requests.length).toBeGreaterThan(0);
  });

  it("handles out-of-order samples (SAMPLES_REORDERED warning)", async () => {
    const curve: TrafficCurve = {
      label: "reordered",
      startIso: new Date(BASE_MS).toISOString(),
      endIso: new Date(BASE_MS + 200_000).toISOString(),
      samples: [
        makeSample(BASE_MS + 120_000, "checkout"),
        makeSample(BASE_MS, "checkout"),
        makeSample(BASE_MS + 60_000, "checkout"),
      ],
    };
    const result = await simulate({
      curve,
      config: { dryRun: true, maxDurationMs: 200_000 },
    });
    const warn = result.ingestionWarnings.find((w) => w.code === "SAMPLES_REORDERED");
    expect(warn).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Edge case: network drop mid-run simulation (handler throws)
// ---------------------------------------------------------------------------

describe("simulate() – handler throws mid-run", () => {
  it("propagates handler errors in dry-run mode", async () => {
    const curve = buildSyntheticCurve({ sampleCount: 2, peakRps: 5 });
    let callCount = 0;

    await expect(
      simulate({
        curve,
        config: { seed: 11, dryRun: true },
        requestHandler: (_req) => {
          callCount++;
          if (callCount === 3) throw new Error("Simulated network drop");
        },
      }),
    ).rejects.toThrow("Simulated network drop");
  });
});

// ---------------------------------------------------------------------------
// Safety in integration context
// ---------------------------------------------------------------------------

describe("simulate() – safety guardrails integration", () => {
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    savedNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (savedNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = savedNodeEnv;
    }
  });

  it("throws SimulationSafetyError when NODE_ENV=production", async () => {
    process.env.NODE_ENV = "production";
    const curve = buildSyntheticCurve();
    await expect(
      simulate({ curve, config: { dryRun: true } }),
    ).rejects.toThrow(SimulationSafetyError);
  });
});

// ---------------------------------------------------------------------------
// ingestFromObject integration round-trip
// ---------------------------------------------------------------------------

describe("ingestFromObject round-trip", () => {
  it("round-trips through JSON serialization", () => {
    const curve = buildSyntheticCurve({ sampleCount: 3 });
    const serialized = JSON.parse(JSON.stringify(curve));
    const result = ingestFromObject(serialized);
    expect(result.curve.label).toBe(curve.label);
    expect(result.curve.samples.length).toBe(curve.samples.length);
  });
});
