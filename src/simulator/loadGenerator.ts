/**
 * Load Generator – shape-matching replay engine.
 *
 * Takes a validated TrafficCurve and a SimulatorConfig and produces a
 * ReplayPlan whose request distribution mirrors the original traffic shape
 * (per-route mix, error rate, and p99 latency distribution).
 *
 * The generator NEVER opens any real network connections.  When dryRun=false
 * it executes a timer-based scheduler, but all "requests" are handled by an
 * injected RequestHandler callback (default: no-op) rather than real HTTP.
 *
 * Safety: the generator refuses to proceed if the SafetyGuardrails check
 * returns a violation, so callers cannot accidentally run against real Stellar.
 *
 * Determinism: when a seed is provided, the PRNG is seeded for reproducible
 * latency jitter.
 */

import { randomUUID } from "crypto";
import {
  ReplayPlan,
  RouteName,
  SimulatedRequest,
  SimulatorConfig,
  TrafficCurve,
} from "./types.js";
import { assertSimulationSafe } from "./safetyGuardrails.js";

// ---------------------------------------------------------------------------
// Minimal seeded PRNG (mulberry32 – fast, zero dependencies)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type Rand = () => number;

/**
 * Sample a latency value from a simple exponential distribution anchored at
 * the historical p99.  The 99th-percentile of Exp(λ) ≈ p99 ⟹ λ = ln(100) / p99.
 * Values are clamped to [1, 3 × p99] to avoid unrealistic outliers.
 */
function sampleLatency(p99Ms: number, rand: Rand): number {
  if (p99Ms <= 0) return 1;
  const lambda = Math.log(100) / p99Ms;
  const raw = -Math.log(1 - rand()) / lambda;
  return Math.max(1, Math.min(Math.round(raw), 3 * p99Ms));
}

/**
 * Aggregate per-route statistics from all samples in the curve.
 */
interface RouteStats {
  totalRequests: number;
  totalErrors: number;
  avgP99Ms: number;
}

function aggregateRouteStats(curve: TrafficCurve): Map<RouteName, RouteStats> {
  const map = new Map<RouteName, RouteStats>();

  for (const sample of curve.samples) {
    const existing = map.get(sample.route) ?? {
      totalRequests: 0,
      totalErrors: 0,
      avgP99Ms: 0,
    };
    map.set(sample.route, {
      totalRequests: existing.totalRequests + sample.requestCount,
      totalErrors: existing.totalErrors + sample.errorCount,
      avgP99Ms:
        existing.totalRequests === 0
          ? sample.p99LatencyMs
          : (existing.avgP99Ms * existing.totalRequests +
              sample.p99LatencyMs * sample.requestCount) /
            (existing.totalRequests + sample.requestCount),
    });
  }

  return map;
}

/**
 * Build a timeline of (routeName, offsetMs) pairs that mirrors the historical
 * shape.  Requests within each minute-window are spread uniformly across the
 * window using jittered spacing so they don't all fire at t=0.
 */
function buildTimeline(
  curve: TrafficCurve,
  config: SimulatorConfig,
  rand: Rand,
): Array<{ route: RouteName; offsetMs: number; p99Ms: number; isError: boolean }> {
  const timeline: Array<{
    route: RouteName;
    offsetMs: number;
    p99Ms: number;
    isError: boolean;
  }> = [];

  const curveStartMs = new Date(curve.startIso).getTime();
  const maxOffset = config.maxDurationMs;

  for (const sample of curve.samples) {
    const windowStart = sample.timestampMs - curveStartMs;
    if (windowStart >= maxOffset) continue; // Truncate beyond maxDurationMs

    const scaledCount = Math.max(
      0,
      Math.round(sample.requestCount * config.scaleFactor),
    );
    const scaledErrors = Math.min(
      scaledCount,
      Math.round(sample.errorCount * config.scaleFactor),
    );

    // Clamp window to stay inside maxDurationMs
    const windowEndRaw = windowStart + 60_000; // 1-minute window
    const windowEnd = Math.min(windowEndRaw, maxOffset);
    const windowDuration = windowEnd - windowStart;

    if (scaledCount === 0 || windowDuration <= 0) continue;

    // Determine which request indices will be errors
    const errorIndices = new Set<number>();
    while (errorIndices.size < scaledErrors) {
      errorIndices.add(Math.floor(rand() * scaledCount));
    }

    for (let i = 0; i < scaledCount; i++) {
      // Jitter: place each request uniformly at random within the window
      const jitter = Math.floor(rand() * windowDuration);
      const offsetMs = windowStart + jitter;

      timeline.push({
        route: sample.route as RouteName,
        offsetMs,
        p99Ms: sample.p99LatencyMs,
        isError: errorIndices.has(i),
      });
    }
  }

  // Sort by scheduled time so the scheduler can walk forwards
  timeline.sort((a, b) => a.offsetMs - b.offsetMs);
  return timeline;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Callback invoked for each simulated request during a live replay. */
export type RequestHandler = (req: SimulatedRequest) => void | Promise<void>;

/** Default handler – no-op, so the generator is safe by default. */
const noopHandler: RequestHandler = () => undefined;

/**
 * Build a ReplayPlan from a validated TrafficCurve.
 *
 * This is a pure (synchronous) function suitable for dry-run and testing.
 * It does NOT execute any timers.
 */
export function buildReplayPlan(
  curve: TrafficCurve,
  config: SimulatorConfig,
): ReplayPlan {
  assertSimulationSafe(curve);

  const rand = config.seed !== undefined ? mulberry32(config.seed) : Math.random;

  const timeline = buildTimeline(curve, config, rand);

  const requests: SimulatedRequest[] = timeline.map((entry) => ({
    id: randomUUID(),
    route: entry.route,
    offsetMs: entry.offsetMs,
    latencyMs: sampleLatency(entry.p99Ms, rand),
    isError: entry.isError,
  }));

  const durationMs =
    requests.length > 0
      ? Math.min(
          requests[requests.length - 1].offsetMs + 1,
          config.maxDurationMs,
        )
      : 0;

  return {
    label: curve.label,
    durationMs,
    requests,
  };
}

/**
 * Execute a ReplayPlan.
 *
 * When dryRun=true (default) the function returns immediately with the plan
 * without sleeping.
 *
 * When dryRun=false it drains the request timeline in real time using
 * setTimeout-based scheduling and calls `handler` for each request.
 */
export async function executeReplayPlan(
  plan: ReplayPlan,
  handler: RequestHandler = noopHandler,
  opts: { dryRun?: boolean; onProgress?: (completed: number, total: number) => void } = {},
): Promise<void> {
  const { dryRun = true, onProgress } = opts;

  if (dryRun || plan.requests.length === 0) {
    // In dry-run mode, invoke the handler synchronously so callers can
    // inspect behaviour without real timers.
    for (const req of plan.requests) {
      await handler(req);
    }
    onProgress?.(plan.requests.length, plan.requests.length);
    return;
  }

  // Live mode: fire requests at their scheduled offsets from `startTime`.
  const startTime = Date.now();
  let completed = 0;
  const total = plan.requests.length;

  await new Promise<void>((resolve) => {
    if (plan.requests.length === 0) {
      resolve();
      return;
    }

    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    for (const req of plan.requests) {
      const delay = Math.max(0, req.offsetMs - (Date.now() - startTime));
      setTimeout(async () => {
        try {
          await handler(req);
        } finally {
          completed++;
          onProgress?.(completed, total);
          if (completed >= total) settle();
        }
      }, delay);
    }
  });
}

/**
 * Convenience wrapper: ingest → plan → execute in one call.
 * Returns the plan so callers can inspect it after execution.
 */
export async function runSimulation(
  curve: TrafficCurve,
  config: SimulatorConfig,
  handler: RequestHandler = noopHandler,
  opts: { onProgress?: (completed: number, total: number) => void } = {},
): Promise<ReplayPlan> {
  const plan = buildReplayPlan(curve, config);
  await executeReplayPlan(plan, handler, {
    dryRun: config.dryRun,
    onProgress: opts.onProgress,
  });
  return plan;
}

export { aggregateRouteStats };
export type { RouteStats };
