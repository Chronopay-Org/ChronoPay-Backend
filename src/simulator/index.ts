/**
 * Capacity Planning Peak Replayer – main orchestrator.
 *
 * Ties together ingestion → load generation → SLO headroom reporting into a
 * single `simulate()` entry point that is easy to call from scripts, tests,
 * and CI pipelines.
 *
 * Usage (programmatic):
 *
 *   import { simulate, buildSyntheticCurve } from "./src/simulator/index.js";
 *
 *   const report = await simulate({
 *     curve: buildSyntheticCurve({ peakRps: 200 }),
 *     config: { scaleFactor: 1.5, dryRun: true },
 *   });
 *   console.log(report);
 *
 * Usage (CLI):  see scripts/capacity-sim.ts
 */

export * from "./types.js";
export * from "./trafficIngester.js";
export * from "./loadGenerator.js";
export * from "./safetyGuardrails.js";
export * from "./sloHeadroomReporter.js";

import {
  ingestFromObject,
  ingestFromFile,
  buildSyntheticCurve,
  IngestionResult,
} from "./trafficIngester.js";
import {
  buildReplayPlan,
  executeReplayPlan,
  RequestHandler,
} from "./loadGenerator.js";
import {
  generateReport,
  formatReport,
} from "./sloHeadroomReporter.js";
import {
  SimulatorConfig,
  SimulatorConfigSchema,
  TrafficCurve,
  SimulationReport,
  ReplayPlan,
} from "./types.js";

// ---------------------------------------------------------------------------
// Simulate options
// ---------------------------------------------------------------------------

export interface SimulateOptions {
  /** Pre-validated TrafficCurve.  Mutually exclusive with `curveFile`. */
  curve?: TrafficCurve;
  /** Path to a JSON file on disk.  Used when `curve` is not provided. */
  curveFile?: string;
  /** Simulator run config (partial – defaults are applied). */
  config?: Partial<SimulatorConfig>;
  /** Optional handler invoked for every simulated request (default: no-op). */
  requestHandler?: RequestHandler;
  /** If true, print the formatted report to stdout. Default: false. */
  printReport?: boolean;
  /** Callback invoked with progress updates during live replay. */
  onProgress?: (completed: number, total: number) => void;
}

export interface SimulateResult {
  /** The resolved and validated traffic curve. */
  curve: TrafficCurve;
  /** Ingestion warnings (e.g. clamped error counts, sparse gaps). */
  ingestionWarnings: IngestionResult["warnings"];
  /** The generated replay plan (all simulated requests). */
  plan: ReplayPlan;
  /** Final simulation report with per-route SLO headroom. */
  report: SimulationReport;
  /** Formatted report string (ready for printing). */
  formattedReport: string;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the full capacity simulation pipeline:
 *
 *   1. Ingest & validate the traffic curve.
 *   2. Build the replay plan (shape-matched, scale-adjusted).
 *   3. Execute (dry-run or live).
 *   4. Compute SLO headroom and return the report.
 */
export async function simulate(opts: SimulateOptions): Promise<SimulateResult> {
  const config = SimulatorConfigSchema.parse(opts.config ?? {});

  // -- Ingestion -----------------------------------------------------------
  let ingestionResult: IngestionResult;

  if (opts.curve) {
    ingestionResult = ingestFromObject(opts.curve);
  } else if (opts.curveFile) {
    ingestionResult = ingestFromFile(opts.curveFile);
  } else {
    // Fall back to a synthetic curve for smoke-test convenience
    const synth = buildSyntheticCurve();
    ingestionResult = ingestFromObject(synth);
  }

  const { curve, warnings: ingestionWarnings } = ingestionResult;

  // -- Plan ----------------------------------------------------------------
  const plan = buildReplayPlan(curve, config);

  // -- Execute -------------------------------------------------------------
  await executeReplayPlan(plan, opts.requestHandler, {
    dryRun: config.dryRun,
    onProgress: opts.onProgress,
  });

  // -- Report --------------------------------------------------------------
  const report = generateReport(plan);
  const formattedReport = formatReport(report);

  if (opts.printReport) {
    console.log(formattedReport);
  }

  return { curve, ingestionWarnings, plan, report, formattedReport };
}
