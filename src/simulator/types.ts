/**
 * Capacity Planning Peak Replayer – shared types and Zod schemas.
 *
 * All external inputs are validated through these schemas so the simulator
 * fails early with a structured error rather than mid-run.
 */

import { z } from "zod";
import type { RouteName } from "../metrics/sloMetrics.js";

// ---------------------------------------------------------------------------
// Re-export the canonical route names from sloMetrics so simulator code never
// duplicates the list.
// ---------------------------------------------------------------------------
export type { RouteName };

// ---------------------------------------------------------------------------
// Traffic sample – one data point in the historical curve.
// ---------------------------------------------------------------------------
export const TrafficSampleSchema = z.object({
  /** Unix epoch ms of the observation window start. */
  timestampMs: z.number().int().positive(),
  /** Route this sample belongs to. */
  route: z.enum(["booking_intent", "slots_list", "checkout", "escrow_listener"]),
  /** Total requests observed in the window. */
  requestCount: z.number().int().nonnegative(),
  /** Requests that resulted in an error (≥ 500 status). */
  errorCount: z.number().int().nonnegative(),
  /** p99 latency in milliseconds. */
  p99LatencyMs: z.number().nonnegative(),
});

export type TrafficSample = z.infer<typeof TrafficSampleSchema>;

// ---------------------------------------------------------------------------
// Historical traffic curve – the ingested window passed to the simulator.
// ---------------------------------------------------------------------------
export const TrafficCurveSchema = z.object({
  /** Informational label for the captured window (e.g. "2026-07-28 peak"). */
  label: z.string().min(1),
  /** ISO 8601 start of the captured window. */
  startIso: z.string().datetime(),
  /** ISO 8601 end of the captured window. */
  endIso: z.string().datetime(),
  /** Ordered array of traffic samples (oldest first). */
  samples: z.array(TrafficSampleSchema).min(1),
});

export type TrafficCurve = z.infer<typeof TrafficCurveSchema>;

// ---------------------------------------------------------------------------
// A single simulated request produced by the load generator.
// ---------------------------------------------------------------------------
export interface SimulatedRequest {
  id: string;
  route: RouteName;
  /** Scheduled wall-clock offset in ms from the replay start. */
  offsetMs: number;
  /** Injected latency in ms (drawn from historical p99). */
  latencyMs: number;
  /** Whether this request should be treated as an error. */
  isError: boolean;
}

// ---------------------------------------------------------------------------
// Load-generator output – the replay plan.
// ---------------------------------------------------------------------------
export interface ReplayPlan {
  label: string;
  durationMs: number;
  requests: SimulatedRequest[];
}

// ---------------------------------------------------------------------------
// Per-route SLO headroom result.
// ---------------------------------------------------------------------------
export interface RouteHeadroom {
  route: RouteName;
  sloObjective: number;
  observedErrorRate: number;
  errorBudgetConsumedFraction: number;
  headroomFraction: number;
  /** Whether the route is within its error budget (headroom > 0). */
  withinBudget: boolean;
  /** Simulated burn rate (observed error rate / error budget). */
  burnRate: number;
}

// ---------------------------------------------------------------------------
// Full simulation report.
// ---------------------------------------------------------------------------
export interface SimulationReport {
  label: string;
  generatedAt: string;
  durationMs: number;
  totalRequests: number;
  routes: RouteHeadroom[];
  /** Overall pass/fail – true when ALL routes are within budget. */
  allWithinBudget: boolean;
}

// ---------------------------------------------------------------------------
// Simulator run config (accepted by the orchestrator).
// ---------------------------------------------------------------------------
export const SimulatorConfigSchema = z.object({
  /** Scale factor applied to historical request counts (default 1.0). */
  scaleFactor: z.number().positive().default(1.0),
  /**
   * Maximum replay duration in ms.  Longer curves are truncated, not skipped.
   * Default: 60_000 ms (1 minute) for test safety.
   */
  maxDurationMs: z.number().int().positive().default(60_000),
  /** Seed for the pseudo-random generator (enables deterministic runs). */
  seed: z.number().int().nonnegative().optional(),
  /**
   * If true the load generator only builds the plan – no async delay loops are
   * executed.  This is always true in CI / unit-test contexts.
   */
  dryRun: z.boolean().default(true),
});

export type SimulatorConfig = z.infer<typeof SimulatorConfigSchema>;
