#!/usr/bin/env tsx
/**
 * capacity-sim.ts – CLI entry point for the capacity planning peak replayer.
 *
 * Usage:
 *
 *   # Smoke run with synthetic traffic (no file required):
 *   npx tsx scripts/capacity-sim.ts --dry-run
 *
 *   # Replay a real captured curve:
 *   npx tsx scripts/capacity-sim.ts --curve-file ./ops/traffic/peak-2026-07-28.json
 *
 *   # Scale up by 2× and fail CI on SLO breach:
 *   npx tsx scripts/capacity-sim.ts --curve-file ./ops/traffic/peak.json \
 *       --scale 2.0 --fail-on-breach
 *
 * Flags:
 *   --curve-file  <path>   Path to a TrafficCurve JSON file.
 *   --scale       <float>  Scale factor (default 1.0).
 *   --max-ms      <int>    Max replay duration in ms (default 60000).
 *   --seed        <int>    PRNG seed for deterministic runs.
 *   --dry-run              Build the plan only, don't execute timers (default).
 *   --live                 Execute the plan with real timer delays.
 *   --fail-on-breach       Exit 1 if any route exceeds its error budget.
 *   --json                 Emit the report as JSON to stdout.
 */

import { fileURLToPath } from "url";
import {
  simulate,
  assertAllWithinBudget,
} from "../src/simulator/index.js";

// ---------------------------------------------------------------------------
// Argument parser (no external deps)
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  curveFile?: string;
  scale: number;
  maxMs: number;
  seed?: number;
  dryRun: boolean;
  failOnBreach: boolean;
  json: boolean;
} {
  const args = argv.slice(2); // strip node + script path
  let curveFile: string | undefined;
  let scale = 1.0;
  let maxMs = 60_000;
  let seed: number | undefined;
  let dryRun = true; // safe default
  let failOnBreach = false;
  let jsonMode = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--curve-file":
        curveFile = args[++i];
        break;
      case "--scale":
        scale = parseFloat(args[++i]);
        if (isNaN(scale) || scale <= 0) {
          console.error("[capacity-sim] --scale must be a positive number");
          process.exit(1);
        }
        break;
      case "--max-ms":
        maxMs = parseInt(args[++i], 10);
        if (isNaN(maxMs) || maxMs <= 0) {
          console.error("[capacity-sim] --max-ms must be a positive integer");
          process.exit(1);
        }
        break;
      case "--seed":
        seed = parseInt(args[++i], 10);
        if (isNaN(seed)) {
          console.error("[capacity-sim] --seed must be an integer");
          process.exit(1);
        }
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--live":
        dryRun = false;
        break;
      case "--fail-on-breach":
        failOnBreach = true;
        break;
      case "--json":
        jsonMode = true;
        break;
      default:
        console.error(`[capacity-sim] Unknown flag: ${arg}`);
        process.exit(1);
    }
  }

  return { curveFile, scale, maxMs, seed, dryRun, failOnBreach, json: jsonMode };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { curveFile, scale, maxMs, seed, dryRun, failOnBreach, json } =
    parseArgs(process.argv);

  if (!json) {
    console.log(`[capacity-sim] Starting simulation…`);
    console.log(`  curve-file : ${curveFile ?? "(synthetic)"}`);
    console.log(`  scale      : ${scale}`);
    console.log(`  max-ms     : ${maxMs}`);
    console.log(`  seed       : ${seed ?? "(random)"}`);
    console.log(`  dry-run    : ${dryRun}`);
  }

  const result = await simulate({
    curveFile,
    config: { scaleFactor: scale, maxDurationMs: maxMs, seed, dryRun },
    printReport: !json,
    onProgress: json
      ? undefined
      : (done, total) => {
          if (done === total) {
            console.log(`[capacity-sim] ✓ ${total} requests processed`);
          }
        },
  });

  // Emit ingestion warnings
  if (!json && result.ingestionWarnings.length > 0) {
    console.warn("[capacity-sim] Ingestion warnings:");
    for (const w of result.ingestionWarnings) {
      console.warn(`  [${w.code}] ${w.message}`);
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify(result.report, null, 2) + "\n");
  }

  if (failOnBreach) {
    try {
      assertAllWithinBudget(result.report);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[capacity-sim] ❌ ${msg}`);
      process.exit(1);
    }
  }

  if (!json) {
    console.log("[capacity-sim] Done.");
  }
}

// Only run when invoked directly (not when imported in tests)
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error("[capacity-sim] Fatal error:", err);
    process.exit(1);
  });
}

export { main, parseArgs };
