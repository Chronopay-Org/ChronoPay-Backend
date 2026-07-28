/**
 * Tests for the historical traffic ingester.
 */

import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  ingestFromObject,
  ingestFromFile,
  buildSyntheticCurve,
  IngestionError,
} from "../../simulator/trafficIngester.js";
import type { TrafficCurve } from "../../simulator/types.js";

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
  requestCount: 100,
  errorCount: 1,
  p99LatencyMs: 80,
  ...overrides,
});

const baseCurve: TrafficCurve = {
  label: "test-peak",
  startIso: new Date(1_000_000).toISOString(),
  endIso: new Date(1_000_000 + 3_600_000).toISOString(),
  samples: [makeSample(1_000_000)],
};

// ---------------------------------------------------------------------------
// ingestFromObject – happy paths
// ---------------------------------------------------------------------------

describe("ingestFromObject – happy path", () => {
  it("returns curve and empty warnings for a valid curve", () => {
    const result = ingestFromObject(baseCurve);
    expect(result.curve.label).toBe("test-peak");
    expect(result.warnings).toHaveLength(0);
  });

  it("returns strongly-typed TrafficCurve", () => {
    const result = ingestFromObject(baseCurve);
    expect(result.curve.samples[0].route).toBe("slots_list");
  });
});

// ---------------------------------------------------------------------------
// ingestFromObject – validation failures
// ---------------------------------------------------------------------------

describe("ingestFromObject – validation failures", () => {
  it("throws IngestionError for non-object input", () => {
    expect(() => ingestFromObject("not an object")).toThrow(IngestionError);
  });

  it("throws IngestionError for missing label", () => {
    const bad = { ...baseCurve, label: undefined };
    expect(() => ingestFromObject(bad)).toThrow(IngestionError);
  });

  it("throws IngestionError for empty label", () => {
    expect(() => ingestFromObject({ ...baseCurve, label: "" })).toThrow(
      IngestionError,
    );
  });

  it("throws IngestionError for invalid startIso", () => {
    expect(() =>
      ingestFromObject({ ...baseCurve, startIso: "not-a-date" }),
    ).toThrow(IngestionError);
  });

  it("throws IngestionError for empty samples array", () => {
    expect(() => ingestFromObject({ ...baseCurve, samples: [] })).toThrow(
      IngestionError,
    );
  });

  it("throws IngestionError when endIso <= startIso", () => {
    const curve = {
      ...baseCurve,
      endIso: baseCurve.startIso, // same time
    };
    expect(() => ingestFromObject(curve)).toThrow(IngestionError);
  });

  it("throws IngestionError when endIso is before startIso", () => {
    const curve = {
      ...baseCurve,
      endIso: new Date(0).toISOString(),
      startIso: new Date(1_000_000).toISOString(),
    };
    expect(() => ingestFromObject(curve)).toThrow(IngestionError);
  });

  it("IngestionError has correct name", () => {
    try {
      ingestFromObject({ ...baseCurve, samples: [] });
    } catch (e) {
      expect((e as IngestionError).name).toBe("IngestionError");
    }
  });
});

// ---------------------------------------------------------------------------
// ingestFromObject – normalisation / warnings
// ---------------------------------------------------------------------------

describe("ingestFromObject – normalisation warnings", () => {
  it("clamps errorCount > requestCount and emits CLAMP_ERROR_COUNT warning", () => {
    const curve: TrafficCurve = {
      ...baseCurve,
      samples: [makeSample(1_000_000, "checkout", { errorCount: 200, requestCount: 100 })],
    };
    const result = ingestFromObject(curve);
    expect(result.curve.samples[0].errorCount).toBe(100);
    const warning = result.warnings.find((w) => w.code === "CLAMP_ERROR_COUNT");
    expect(warning).toBeDefined();
  });

  it("sorts out-of-order samples and emits SAMPLES_REORDERED warning", () => {
    const curve: TrafficCurve = {
      ...baseCurve,
      samples: [
        makeSample(2_000_000),
        makeSample(1_000_000),
        makeSample(3_000_000),
      ],
    };
    const result = ingestFromObject(curve);
    const timestamps = result.curve.samples.map((s) => s.timestampMs);
    expect(timestamps).toEqual([1_000_000, 2_000_000, 3_000_000]);
    const warning = result.warnings.find((w) => w.code === "SAMPLES_REORDERED");
    expect(warning).toBeDefined();
  });

  it("does NOT emit SAMPLES_REORDERED when already ordered", () => {
    const curve: TrafficCurve = {
      ...baseCurve,
      samples: [makeSample(1_000_000), makeSample(2_000_000)],
    };
    const result = ingestFromObject(curve);
    const reorderWarning = result.warnings.find(
      (w) => w.code === "SAMPLES_REORDERED",
    );
    expect(reorderWarning).toBeUndefined();
  });

  it("detects sparse range and emits SPARSE_RANGE warning", () => {
    // Normal gap ~60s, then a 600s gap
    const base = 1_700_000_000_000;
    const curve: TrafficCurve = {
      ...baseCurve,
      endIso: new Date(base + 800_000).toISOString(),
      samples: [
        makeSample(base),
        makeSample(base + 60_000),
        makeSample(base + 120_000),
        makeSample(base + 720_000), // 600s gap – 5× median
      ],
    };
    const result = ingestFromObject(curve);
    const sparseWarning = result.warnings.find((w) => w.code === "SPARSE_RANGE");
    expect(sparseWarning).toBeDefined();
    expect(sparseWarning!.message).toContain("Gap of 600000ms");
  });

  it("does NOT emit SPARSE_RANGE for uniform spacing", () => {
    const base = 1_700_000_000_000;
    const samples = Array.from({ length: 5 }, (_, i) =>
      makeSample(base + i * 60_000),
    );
    const curve: TrafficCurve = {
      ...baseCurve,
      endIso: new Date(base + 5 * 60_000).toISOString(),
      samples,
    };
    const result = ingestFromObject(curve);
    const sparseWarning = result.warnings.find((w) => w.code === "SPARSE_RANGE");
    expect(sparseWarning).toBeUndefined();
  });

  it("does NOT emit SPARSE_RANGE for single sample (no intervals)", () => {
    const result = ingestFromObject(baseCurve);
    const sparseWarning = result.warnings.find((w) => w.code === "SPARSE_RANGE");
    expect(sparseWarning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ingestFromFile
// ---------------------------------------------------------------------------

describe("ingestFromFile", () => {
  it("reads and parses a valid JSON file", () => {
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `test-curve-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(baseCurve), "utf-8");

    try {
      const result = ingestFromFile(tmpFile);
      expect(result.curve.label).toBe("test-peak");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("throws IngestionError for a non-existent file", () => {
    expect(() => ingestFromFile("/nonexistent/path/curve.json")).toThrow(
      IngestionError,
    );
  });

  it("throws IngestionError for a file with invalid JSON", () => {
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `bad-curve-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, "not json { }", "utf-8");

    try {
      expect(() => ingestFromFile(tmpFile)).toThrow(IngestionError);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("throws IngestionError for a file with a valid JSON but invalid curve", () => {
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `schema-fail-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ foo: "bar" }), "utf-8");

    try {
      expect(() => ingestFromFile(tmpFile)).toThrow(IngestionError);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

// ---------------------------------------------------------------------------
// buildSyntheticCurve
// ---------------------------------------------------------------------------

describe("buildSyntheticCurve", () => {
  it("returns a curve that passes ingestFromObject validation", () => {
    const curve = buildSyntheticCurve();
    expect(() => ingestFromObject(curve)).not.toThrow();
  });

  it("returns the expected number of samples (sampleCount × 4 routes)", () => {
    const curve = buildSyntheticCurve({ sampleCount: 10 });
    expect(curve.samples).toHaveLength(40); // 10 windows × 4 routes
  });

  it("uses provided label", () => {
    const curve = buildSyntheticCurve({ label: "my-peak" });
    expect(curve.label).toBe("my-peak");
  });

  it("respects peakRps", () => {
    const curve = buildSyntheticCurve({ peakRps: 50, sampleCount: 10 });
    const maxRequests = Math.max(...curve.samples.map((s) => s.requestCount));
    // Peak: 50 × 60 = 3000; sin(π/2) ≈ 1 but nearest sample may be close
    expect(maxRequests).toBeGreaterThan(0);
    expect(maxRequests).toBeLessThanOrEqual(50 * 60);
  });

  it("produces errorCount ≤ requestCount for all samples", () => {
    const curve = buildSyntheticCurve({ errorRateFraction: 0.1 });
    for (const s of curve.samples) {
      expect(s.errorCount).toBeLessThanOrEqual(s.requestCount);
    }
  });

  it("uses defaults when no options passed", () => {
    const curve = buildSyntheticCurve();
    expect(curve.label).toBe("synthetic-peak");
    expect(curve.samples.length).toBe(60 * 4); // default 60 samples × 4 routes
  });
});
