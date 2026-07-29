/**
 * Tests for the capacity-sim CLI script.
 */

import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseArgs, main } from "../capacity-sim.js";
import { buildSyntheticCurve } from "../../src/simulator/index.js";

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  const base = ["node", "scripts/capacity-sim.ts"];

  it("returns defaults when no flags provided", () => {
    const result = parseArgs([...base]);
    expect(result.scale).toBe(1.0);
    expect(result.maxMs).toBe(60_000);
    expect(result.dryRun).toBe(true);
    expect(result.failOnBreach).toBe(false);
    expect(result.json).toBe(false);
    expect(result.curveFile).toBeUndefined();
    expect(result.seed).toBeUndefined();
  });

  it("parses --curve-file", () => {
    const result = parseArgs([...base, "--curve-file", "/tmp/curve.json"]);
    expect(result.curveFile).toBe("/tmp/curve.json");
  });

  it("parses --scale", () => {
    const result = parseArgs([...base, "--scale", "2.5"]);
    expect(result.scale).toBe(2.5);
  });

  it("parses --max-ms", () => {
    const result = parseArgs([...base, "--max-ms", "30000"]);
    expect(result.maxMs).toBe(30_000);
  });

  it("parses --seed", () => {
    const result = parseArgs([...base, "--seed", "42"]);
    expect(result.seed).toBe(42);
  });

  it("parses --live (sets dryRun=false)", () => {
    const result = parseArgs([...base, "--live"]);
    expect(result.dryRun).toBe(false);
  });

  it("parses --dry-run (sets dryRun=true)", () => {
    const result = parseArgs([...base, "--live", "--dry-run"]);
    expect(result.dryRun).toBe(true);
  });

  it("parses --fail-on-breach", () => {
    const result = parseArgs([...base, "--fail-on-breach"]);
    expect(result.failOnBreach).toBe(true);
  });

  it("parses --json", () => {
    const result = parseArgs([...base, "--json"]);
    expect(result.json).toBe(true);
  });

  it("parses multiple flags together", () => {
    const result = parseArgs([
      ...base,
      "--scale", "1.5",
      "--seed", "99",
      "--max-ms", "45000",
      "--fail-on-breach",
      "--json",
    ]);
    expect(result.scale).toBe(1.5);
    expect(result.seed).toBe(99);
    expect(result.maxMs).toBe(45_000);
    expect(result.failOnBreach).toBe(true);
    expect(result.json).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// main() – integration tests
// ---------------------------------------------------------------------------

describe("main() – synthetic curve (no file)", () => {
  it("completes without throwing for a default dry run", async () => {
    // Override argv for the main function
    const originalArgv = process.argv;
    process.argv = ["node", "scripts/capacity-sim.ts", "--dry-run"];
    try {
      await expect(main()).resolves.toBeUndefined();
    } finally {
      process.argv = originalArgv;
    }
  });

  it("completes with --json flag", async () => {
    const originalArgv = process.argv;
    const originalWrite = process.stdout.write.bind(process.stdout);
    let jsonOutput = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      if (typeof chunk === "string") jsonOutput += chunk;
      return true;
    }) as typeof process.stdout.write;

    process.argv = ["node", "scripts/capacity-sim.ts", "--dry-run", "--json"];
    try {
      await main();
      const parsed = JSON.parse(jsonOutput);
      expect(parsed).toHaveProperty("label");
      expect(parsed).toHaveProperty("routes");
      expect(parsed).toHaveProperty("allWithinBudget");
    } finally {
      process.argv = originalArgv;
      process.stdout.write = originalWrite;
    }
  });
});

describe("main() – with a curve file", () => {
  it("reads curve from file and completes", async () => {
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `cap-sim-test-${Date.now()}.json`);
    const curve = buildSyntheticCurve({ sampleCount: 3, peakRps: 10 });
    fs.writeFileSync(tmpFile, JSON.stringify(curve), "utf-8");

    const originalArgv = process.argv;
    process.argv = [
      "node",
      "scripts/capacity-sim.ts",
      "--curve-file", tmpFile,
      "--dry-run",
    ];
    try {
      await expect(main()).resolves.toBeUndefined();
    } finally {
      process.argv = originalArgv;
      fs.unlinkSync(tmpFile);
    }
  });
});
