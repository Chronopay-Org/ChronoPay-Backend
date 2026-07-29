/**
 * Historical Traffic Ingester
 *
 * Responsible for loading, validating, and normalising traffic curves that
 * the load generator replays.  Input may come from:
 *   - A plain JSON object (in-memory / unit tests)
 *   - A JSON file path (CLI usage)
 *
 * The ingester validates the curve with the Zod schema before returning it,
 * so callers receive a strongly-typed, guaranteed-valid TrafficCurve.
 *
 * Edge cases handled:
 *   - Empty sample array         → throws IngestionError
 *   - Samples out of order       → sorted in place
 *   - endIso < startIso          → throws IngestionError
 *   - errorCount > requestCount  → clamped with a warning
 *   - Missing historical range   → detected and reported via IngestionWarning
 */

import { readFileSync } from "fs";
import { ZodError } from "zod";
import {
  TrafficCurve,
  TrafficCurveSchema,
  TrafficSample,
} from "./types.js";

// ---------------------------------------------------------------------------
// Custom error types
// ---------------------------------------------------------------------------

export class IngestionError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "IngestionError";
  }
}

export interface IngestionWarning {
  code: "CLAMP_ERROR_COUNT" | "SAMPLES_REORDERED" | "SPARSE_RANGE";
  message: string;
}

export interface IngestionResult {
  curve: TrafficCurve;
  warnings: IngestionWarning[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect gaps > 2× median inter-sample interval (sparse range detection). */
function detectSparseRanges(
  samples: TrafficSample[],
  warnings: IngestionWarning[],
): void {
  if (samples.length < 2) return;

  const intervals: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    intervals.push(samples[i].timestampMs - samples[i - 1].timestampMs);
  }

  // Filter out zero-length intervals: these occur when multiple routes share
  // the same timestamp (expected in multi-route curves), and a zero median
  // would cause every non-zero gap to register as sparse.
  const positiveIntervals = intervals.filter((v) => v > 0);
  if (positiveIntervals.length === 0) return; // all same timestamp, nothing to analyse

  const sorted = [...positiveIntervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  for (let i = 0; i < intervals.length; i++) {
    if (intervals[i] > 2 * median) {
      warnings.push({
        code: "SPARSE_RANGE",
        message:
          `Gap of ${intervals[i]}ms detected between sample[${i}] and sample[${i + 1}] ` +
          `(2× median is ${2 * median}ms). Historical data may be incomplete.`,
      });
    }
  }
}

/** Normalise a raw (potentially untrusted) object into a validated TrafficCurve. */
function normalise(
  raw: unknown,
  warnings: IngestionWarning[],
): TrafficCurve {
  // Parse & validate with Zod
  let curve: TrafficCurve;
  try {
    curve = TrafficCurveSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new IngestionError(
        `Traffic curve failed schema validation: ${err.message}`,
        err,
      );
    }
    throw new IngestionError("Unknown validation error", err);
  }

  // Validate time ordering
  const startMs = new Date(curve.startIso).getTime();
  const endMs = new Date(curve.endIso).getTime();
  if (endMs <= startMs) {
    throw new IngestionError(
      `endIso (${curve.endIso}) must be after startIso (${curve.startIso})`,
    );
  }

  // Sort samples if out of order
  const originalOrder = curve.samples.map((s) => s.timestampMs);
  const sorted = [...curve.samples].sort((a, b) => a.timestampMs - b.timestampMs);
  const wasReordered = sorted.some((s, i) => s.timestampMs !== originalOrder[i]);
  if (wasReordered) {
    warnings.push({
      code: "SAMPLES_REORDERED",
      message: "Samples were not in chronological order and have been sorted.",
    });
    // Zod parse produces a new object, so we need a mutable copy
    curve = { ...curve, samples: sorted };
  }

  // Clamp errorCount ≤ requestCount
  const clampedSamples = curve.samples.map((s) => {
    if (s.errorCount > s.requestCount) {
      warnings.push({
        code: "CLAMP_ERROR_COUNT",
        message:
          `Sample at ${s.timestampMs} for route "${s.route}" had errorCount ` +
          `(${s.errorCount}) > requestCount (${s.requestCount}). Clamped.`,
      });
      return { ...s, errorCount: s.requestCount };
    }
    return s;
  });
  curve = { ...curve, samples: clampedSamples };

  // Detect sparse ranges
  detectSparseRanges(curve.samples, warnings);

  return curve;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ingest a TrafficCurve from an in-memory object.
 *
 * Useful for tests and programmatic callers that already have the JSON parsed.
 */
export function ingestFromObject(raw: unknown): IngestionResult {
  const warnings: IngestionWarning[] = [];
  const curve = normalise(raw, warnings);
  return { curve, warnings };
}

/**
 * Ingest a TrafficCurve from a JSON file on disk.
 *
 * Throws IngestionError if the file cannot be read or fails validation.
 */
export function ingestFromFile(filePath: string): IngestionResult {
  let raw: unknown;
  try {
    const content = readFileSync(filePath, "utf-8");
    raw = JSON.parse(content);
  } catch (err) {
    throw new IngestionError(
      `Failed to read or parse traffic curve file "${filePath}": ${String(err)}`,
      err,
    );
  }
  return ingestFromObject(raw);
}

/**
 * Build a minimal synthetic TrafficCurve for testing / smoke runs.
 *
 * Generates `sampleCount` evenly-spaced 1-minute samples starting at
 * `startMs`, with request counts drawn from a sinusoidal "peak" pattern.
 */
export function buildSyntheticCurve(opts?: {
  startMs?: number;
  sampleCount?: number;
  peakRps?: number;
  errorRateFraction?: number;
  label?: string;
}): TrafficCurve {
  const {
    startMs = Date.now() - 60 * 60 * 1000,
    sampleCount = 60,
    peakRps = 100,
    errorRateFraction = 0.001,
    label = "synthetic-peak",
  } = opts ?? {};

  const WINDOW_MS = 60_000; // 1-minute windows
  const samples: TrafficSample[] = [];

  const routes = [
    "booking_intent",
    "slots_list",
    "checkout",
    "escrow_listener",
  ] as const;

  for (let i = 0; i < sampleCount; i++) {
    const ts = startMs + i * WINDOW_MS;
    // Sinusoidal peak pattern: peak at mid-range
    const phase = (i / sampleCount) * Math.PI;
    const rps = Math.max(1, Math.round(peakRps * Math.sin(phase)));

    for (const route of routes) {
      const requestCount = rps * 60; // requests per minute
      const errorCount = Math.round(requestCount * errorRateFraction);
      const p99LatencyMs =
        route === "checkout" ? 250 + i * 0.5 : 80 + i * 0.2;

      samples.push({
        timestampMs: ts,
        route,
        requestCount,
        errorCount,
        p99LatencyMs,
      });
    }
  }

  const endMs = startMs + sampleCount * WINDOW_MS;
  return {
    label,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    samples,
  };
}
