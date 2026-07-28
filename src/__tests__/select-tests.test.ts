/**
 * src/__tests__/select-tests.test.ts
 *
 * Unit tests for scripts/select-tests.ts
 *
 * Coverage targets (≥ 95 %):
 *   loadGraph      — valid file, missing file, bad JSON, non-object JSON
 *   resolveTests   — single file, multi-file union+dedup, empty-list sentinel,
 *                    unknown file, empty changeset, Windows backslashes,
 *                    cross-package edit, first-unknown short-circuits
 *   filterExisting — all exist, some missing, all missing, empty input
 *   selectTests    — happy path, corrupt graph, missing graph, unknown file,
 *                    CI sentinel, no changed files, all tests deleted,
 *                    partial deletion, sorted output, resolve throws
 *   parseArgs      — via selectTests integration; CLI path covered separately
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

// ESM-safe __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import {
  FULL_RUN_SENTINEL,
  filterExisting,
  loadGraph,
  resolveTests,
  selectTests,
} from "../../scripts/select-tests.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "select-tests-"));
}

function writeJson(dir: string, name: string, content: unknown): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(content), "utf-8");
  return p;
}

function touchFile(dir: string, ...parts: string[]): string {
  const full = path.join(dir, ...parts);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "// placeholder\n", "utf-8");
  return full;
}

// ---------------------------------------------------------------------------
// loadGraph
// ---------------------------------------------------------------------------

describe("loadGraph", () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });

  it("returns parsed object for a valid graph file", () => {
    const graph = { "src/foo.ts": ["src/__tests__/foo.test.ts"] };
    const p = writeJson(dir, "graph.json", graph);
    expect(loadGraph(p)).toEqual(graph);
  });

  it("throws on a missing file", () => {
    expect(() => loadGraph(path.join(dir, "nope.json"))).toThrow();
  });

  it("throws on malformed JSON", () => {
    const p = path.join(dir, "bad.json");
    fs.writeFileSync(p, "{ not json }", "utf-8");
    expect(() => loadGraph(p)).toThrow();
  });

  it("throws when root value is an array", () => {
    const p = writeJson(dir, "arr.json", ["a", "b"]);
    expect(() => loadGraph(p)).toThrow(/JSON object/);
  });

  it("throws when root value is null", () => {
    const p = path.join(dir, "null.json");
    fs.writeFileSync(p, "null", "utf-8");
    expect(() => loadGraph(p)).toThrow(/JSON object/);
  });

  it("throws when root value is a string", () => {
    const p = writeJson(dir, "str.json", "hello");
    expect(() => loadGraph(p)).toThrow(/JSON object/);
  });
});

// ---------------------------------------------------------------------------
// resolveTests
// ---------------------------------------------------------------------------

describe("resolveTests", () => {
  const graph = {
    "src/services/checkout.ts": [
      "src/__tests__/checkout-pay.test.ts",
      "src/routes/__tests__/checkout.test.ts",
    ],
    "src/middleware/rbac.ts": [
      "src/__tests__/rbac-hierarchy.test.ts",
    ],
    "src/routes/webhooks.ts": [
      "src/__tests__/webhooks.test.ts",
      "src/routes/__tests__/webhooks.test.ts",
    ],
    "jest.config.cjs": [],
  };

  it("maps a single file to its tests (sorted)", () => {
    const result = resolveTests(["src/services/checkout.ts"], graph);
    expect(result).toEqual({
      kind: "selected",
      tests: [
        "src/__tests__/checkout-pay.test.ts",
        "src/routes/__tests__/checkout.test.ts",
      ],
    });
  });

  it("unions tests from multiple files, deduplicates, and sorts", () => {
    const result = resolveTests(
      ["src/services/checkout.ts", "src/middleware/rbac.ts"],
      graph,
    );
    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") return;
    expect(result.tests).toEqual([
      "src/__tests__/checkout-pay.test.ts",
      "src/__tests__/rbac-hierarchy.test.ts",
      "src/routes/__tests__/checkout.test.ts",
    ]);
    // No duplicates
    expect(result.tests.length).toBe(new Set(result.tests).size);
  });

  it("returns full_run for an unknown file", () => {
    const result = resolveTests(["src/new/unknown.ts"], graph);
    expect(result).toEqual({
      kind: "full_run",
      reason: expect.stringContaining("not in graph"),
    });
  });

  it("returns full_run when a file maps to an empty list (sentinel)", () => {
    const result = resolveTests(["jest.config.cjs"], graph);
    expect(result).toEqual({
      kind: "full_run",
      reason: expect.stringContaining("full-run sentinel"),
    });
  });

  it("returns full_run for an empty changed-files list", () => {
    const result = resolveTests([], graph);
    expect(result).toEqual({
      kind: "full_run",
      reason: expect.stringContaining("no changed files"),
    });
  });

  it("normalises Windows backslash paths before lookup", () => {
    const result = resolveTests(["src\\services\\checkout.ts"], graph);
    expect(result.kind).toBe("selected");
  });

  it("short-circuits on first unknown file even if later files are known", () => {
    const result = resolveTests(
      ["src/new/unknown.ts", "src/services/checkout.ts"],
      graph,
    );
    expect(result.kind).toBe("full_run");
  });

  it("handles a cross-package edit (two unrelated source files)", () => {
    const result = resolveTests(
      ["src/routes/webhooks.ts", "src/middleware/rbac.ts"],
      graph,
    );
    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") return;
    expect(result.tests).toContain("src/__tests__/webhooks.test.ts");
    expect(result.tests).toContain("src/__tests__/rbac-hierarchy.test.ts");
  });

  it("deduplicates tests appearing in multiple file mappings", () => {
    const g = {
      "src/a.ts": ["src/__tests__/shared.test.ts", "src/__tests__/a.test.ts"],
      "src/b.ts": ["src/__tests__/shared.test.ts", "src/__tests__/b.test.ts"],
    };
    const result = resolveTests(["src/a.ts", "src/b.ts"], g);
    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") return;
    expect(result.tests.filter((t) => t === "src/__tests__/shared.test.ts")).toHaveLength(1);
  });

  it("output is always sorted", () => {
    const result = resolveTests(
      ["src/routes/webhooks.ts", "src/services/checkout.ts"],
      graph,
    );
    if (result.kind !== "selected") return;
    const sorted = [...result.tests].sort();
    expect(result.tests).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// filterExisting
// ---------------------------------------------------------------------------

describe("filterExisting", () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });

  it("keeps all tests that exist on disk", () => {
    touchFile(dir, "src/__tests__/a.test.ts");
    touchFile(dir, "src/__tests__/b.test.ts");
    const result = filterExisting(
      ["src/__tests__/a.test.ts", "src/__tests__/b.test.ts"],
      dir,
    );
    expect(result).toEqual([
      "src/__tests__/a.test.ts",
      "src/__tests__/b.test.ts",
    ]);
  });

  it("drops tests that do not exist on disk", () => {
    touchFile(dir, "src/__tests__/a.test.ts");
    const result = filterExisting(
      ["src/__tests__/a.test.ts", "src/__tests__/deleted.test.ts"],
      dir,
    );
    expect(result).toEqual(["src/__tests__/a.test.ts"]);
  });

  it("returns empty array when all tests are missing", () => {
    const result = filterExisting(["src/__tests__/gone.test.ts"], dir);
    expect(result).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(filterExisting([], dir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// selectTests (public API)
// ---------------------------------------------------------------------------

describe("selectTests", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  /** Write graph + create test files and return graphPath. */
  function setup(
    graph: Record<string, string[]>,
    existingTests: string[],
  ): string {
    const graphPath = writeJson(dir, "test-graph.json", graph);
    for (const t of existingTests) {
      touchFile(dir, t);
    }
    return graphPath;
  }

  it("happy path — returns selected tests", () => {
    const graphPath = setup(
      { "src/services/checkout.ts": ["src/__tests__/checkout-pay.test.ts"] },
      ["src/__tests__/checkout-pay.test.ts"],
    );
    const result = selectTests(
      ["src/services/checkout.ts"],
      graphPath,
      dir,
    );
    expect(result).toEqual({
      kind: "selected",
      tests: ["src/__tests__/checkout-pay.test.ts"],
    });
  });

  it("returns full_run when graph file is missing", () => {
    const result = selectTests(
      ["src/services/checkout.ts"],
      path.join(dir, "no-such-file.json"),
      dir,
    );
    expect(result).toEqual({
      kind: "full_run",
      reason: expect.stringContaining("failed to load graph"),
    });
  });

  it("returns full_run when graph JSON is corrupt", () => {
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{ bad json }", "utf-8");
    const result = selectTests(["src/services/checkout.ts"], bad, dir);
    expect(result.kind).toBe("full_run");
  });

  it("returns full_run when graph is not an object", () => {
    const p = writeJson(dir, "g.json", [1, 2, 3]);
    const result = selectTests(["src/services/checkout.ts"], p, dir);
    expect(result.kind).toBe("full_run");
  });

  it("returns full_run when changed file is not in graph", () => {
    const graphPath = setup({ "src/known.ts": ["src/__tests__/known.test.ts"] }, []);
    const result = selectTests(["src/unknown-brand-new.ts"], graphPath, dir);
    expect(result.kind).toBe("full_run");
  });

  it("returns full_run when file maps to empty list (CI sentinel)", () => {
    const graphPath = setup({ "jest.config.cjs": [] }, []);
    const result = selectTests(["jest.config.cjs"], graphPath, dir);
    expect(result.kind).toBe("full_run");
  });

  it("returns full_run when no changed files are provided", () => {
    const graphPath = setup(
      { "src/services/checkout.ts": ["src/__tests__/checkout-pay.test.ts"] },
      [],
    );
    const result = selectTests([], graphPath, dir);
    expect(result.kind).toBe("full_run");
  });

  it("returns full_run when all resolved tests are missing on disk", () => {
    const graphPath = setup(
      { "src/services/checkout.ts": ["src/__tests__/deleted.test.ts"] },
      [], // test file not created
    );
    const result = selectTests(
      ["src/services/checkout.ts"],
      graphPath,
      dir,
    );
    expect(result).toEqual({
      kind: "full_run",
      reason: expect.stringContaining("missing on disk"),
    });
  });

  it("drops only the missing test when some are deleted", () => {
    const graphPath = setup(
      {
        "src/services/checkout.ts": [
          "src/__tests__/checkout-pay.test.ts",
          "src/__tests__/deleted.test.ts",
        ],
      },
      ["src/__tests__/checkout-pay.test.ts"],
    );
    const result = selectTests(
      ["src/services/checkout.ts"],
      graphPath,
      dir,
    );
    expect(result).toEqual({
      kind: "selected",
      tests: ["src/__tests__/checkout-pay.test.ts"],
    });
  });

  it("result tests are sorted", () => {
    const graphPath = setup(
      {
        "src/services/checkout.ts": [
          "src/__tests__/z.test.ts",
          "src/__tests__/a.test.ts",
          "src/__tests__/m.test.ts",
        ],
      },
      [
        "src/__tests__/z.test.ts",
        "src/__tests__/a.test.ts",
        "src/__tests__/m.test.ts",
      ],
    );
    const result = selectTests(
      ["src/services/checkout.ts"],
      graphPath,
      dir,
    );
    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") return;
    const sorted = [...result.tests].sort();
    expect(result.tests).toEqual(sorted);
  });

  it("handles Windows-style backslash paths in changedFiles", () => {
    const graphPath = setup(
      { "src/services/checkout.ts": ["src/__tests__/checkout-pay.test.ts"] },
      ["src/__tests__/checkout-pay.test.ts"],
    );
    const result = selectTests(
      ["src\\services\\checkout.ts"],
      graphPath,
      dir,
    );
    expect(result).toEqual({
      kind: "selected",
      tests: ["src/__tests__/checkout-pay.test.ts"],
    });
  });

  it("returns full_run when resolveTests throws unexpectedly", () => {
    // Directly exercise the defensive catch in selectTests by passing a
    // graph whose value is not an iterable array.  The loadGraph call
    // succeeds (it's a plain object), but when resolveTests tries to
    // spread the value it will throw — confirming the outer catch falls
    // back to full_run.
    const p = path.join(dir, "g.json");
    // Manually write JSON with a non-array value; TypeScript cast bypassed at runtime.
    fs.writeFileSync(p, JSON.stringify({ "src/a.ts": null }), "utf-8");
    touchFile(dir, "src/__tests__/a.test.ts");
    const result = selectTests(["src/a.ts"], p, dir);
    // null is not iterable → resolveTests throws → full_run
    expect(result.kind).toBe("full_run");
  });

  it("multi-file cross-package edit unions both packages' tests", () => {
    const graphPath = setup(
      {
        "src/routes/webhooks.ts": ["src/__tests__/webhooks.test.ts"],
        "src/middleware/rbac.ts": ["src/__tests__/rbac-hierarchy.test.ts"],
      },
      [
        "src/__tests__/webhooks.test.ts",
        "src/__tests__/rbac-hierarchy.test.ts",
      ],
    );
    const result = selectTests(
      ["src/routes/webhooks.ts", "src/middleware/rbac.ts"],
      graphPath,
      dir,
    );
    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") return;
    expect(result.tests).toContain("src/__tests__/webhooks.test.ts");
    expect(result.tests).toContain("src/__tests__/rbac-hierarchy.test.ts");
  });

  it("verifies the committed graph file is valid JSON with required keys", () => {
    const realGraph = path.join(__dirname, "../../scripts/test-graph.json");
    if (!fs.existsSync(realGraph)) return;
    const graph = loadGraph(realGraph);
    expect(typeof graph).toBe("object");
    expect(graph["__ci_files__"]).toEqual([]);
    expect(graph["scripts/select-tests.ts"]).toContain(
      "src/__tests__/select-tests.test.ts",
    );
    expect(graph["scripts/test-graph.json"]).toContain(
      "src/__tests__/select-tests.test.ts",
    );
  });

  it("verifies CI/config files in committed graph map to empty list", () => {
    const realGraph = path.join(__dirname, "../../scripts/test-graph.json");
    if (!fs.existsSync(realGraph)) return;
    const graph = loadGraph(realGraph);
    const ciFiles = [
      "jest.config.cjs",
      "tsconfig.json",
      "package.json",
      ".github/workflows/ci.yml",
    ];
    for (const f of ciFiles) {
      if (f in graph) {
        expect(graph[f]).toEqual([]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });

  it("duplicate test entries in a single mapping are deduplicated", () => {
    const graphPath = writeJson(dir, "g.json", {
      "src/a.ts": [
        "src/__tests__/a.test.ts",
        "src/__tests__/a.test.ts", // intentional duplicate
        "src/__tests__/b.test.ts",
      ],
    });
    touchFile(dir, "src/__tests__/a.test.ts");
    touchFile(dir, "src/__tests__/b.test.ts");
    const result = selectTests(["src/a.ts"], graphPath, dir);
    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") return;
    expect(result.tests).toEqual(["src/__tests__/a.test.ts", "src/__tests__/b.test.ts"]);
    expect(result.tests.length).toBe(new Set(result.tests).size);
  });

  it("first unknown file in a list short-circuits even if later files are known", () => {
    const graphPath = writeJson(dir, "g.json", {
      "src/known.ts": ["src/__tests__/known.test.ts"],
    });
    touchFile(dir, "src/__tests__/known.test.ts");
    const result = selectTests(
      ["src/brand-new.ts", "src/known.ts"],
      graphPath,
      dir,
    );
    expect(result.kind).toBe("full_run");
  });

  it("FULL_RUN_SENTINEL constant has the expected value", () => {
    expect(FULL_RUN_SENTINEL).toBe("__full_run__");
  });
});
