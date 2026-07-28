/**
 * select-tests.ts — CI test selection via a static file-to-test dependency graph.
 *
 * Usage:
 *   npx tsx scripts/select-tests.ts \
 *     --changed-files src/services/checkout.ts src/routes/checkout.ts \
 *     [--graph scripts/test-graph.json] \
 *     [--output /tmp/selected-tests.txt]
 *
 * Output (stdout or --output file):
 *   • A newline-separated list of test file paths to pass to Jest, OR
 *   • The sentinel string "__full_run__" when a full suite run is required.
 *
 * Exit codes:
 *   0 — always; callers read the output to decide what to run.
 *
 * Safety contract
 * ---------------
 * • Any I/O or JSON parse error          → full run (fail-open).
 * • Changed file not present in graph    → full run (conservative).
 * • File maps to [] (empty list)         → full run (CI/config sentinel).
 * • No changed files provided            → full run (conservative).
 * • Resolved test file absent on disk    → silently dropped.
 * • All resolved tests absent on disk    → full run.
 * • Any unexpected internal error        → full run.
 */
import * as fs from "fs";
import * as path from "path";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const FULL_RUN_SENTINEL = "__full_run__";
export const DEFAULT_GRAPH_PATH = path.join("scripts", "test-graph.json");
// ---------------------------------------------------------------------------
// Core functions (exported for unit testing)
// ---------------------------------------------------------------------------
/**
 * Load and validate the test graph from disk.
 *
 * @throws {Error} on any read or parse failure — callers should catch.
 */
export function loadGraph(graphPath) {
    const raw = fs.readFileSync(graphPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`test-graph.json must be a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`);
    }
    return parsed;
}
/**
 * Map a list of changed files to the set of tests that cover them.
 *
 * Returns a SelectResult indicating either a full run or a specific test list.
 */
export function resolveTests(changedFiles, graph) {
    if (changedFiles.length === 0) {
        return { kind: "full_run", reason: "no changed files provided" };
    }
    const selected = new Set();
    for (const file of changedFiles) {
        // Normalise to forward slashes for cross-platform consistency.
        const posix = file.replace(/\\/g, "/");
        if (!(posix in graph)) {
            return {
                kind: "full_run",
                reason: `file not in graph: ${posix}`,
            };
        }
        const mapped = graph[posix];
        if (mapped.length === 0) {
            return {
                kind: "full_run",
                reason: `file maps to empty list (full-run sentinel): ${posix}`,
            };
        }
        for (const t of mapped) {
            selected.add(t);
        }
    }
    return { kind: "selected", tests: [...selected].sort() };
}
/**
 * Drop test paths that no longer exist on disk (handles deleted-test edge case).
 */
export function filterExisting(tests, repoRoot) {
    return tests.filter((t) => {
        const abs = path.join(repoRoot, t);
        return fs.existsSync(abs);
    });
}
/**
 * Public API: resolve changed files to a test list, falling back to full run
 * on any error or ambiguity.
 *
 * @param changedFiles - Relative paths of changed files (any slash style).
 * @param graphPath    - Path to the test-graph.json file.
 * @param repoRoot     - Repo root for existence checks (default: cwd).
 */
export function selectTests(changedFiles, graphPath = DEFAULT_GRAPH_PATH, repoRoot = process.cwd()) {
    let graph;
    try {
        graph = loadGraph(graphPath);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { kind: "full_run", reason: `failed to load graph: ${msg}` };
    }
    let result;
    try {
        result = resolveTests(changedFiles, graph);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { kind: "full_run", reason: `unexpected resolve error: ${msg}` };
    }
    if (result.kind === "full_run") {
        return result;
    }
    const existing = filterExisting(result.tests, repoRoot);
    if (existing.length === 0) {
        return {
            kind: "full_run",
            reason: "all resolved test files are missing on disk",
        };
    }
    return { kind: "selected", tests: existing };
}
// ---------------------------------------------------------------------------
// CLI entry point — not exercised by unit tests
// ---------------------------------------------------------------------------
/* istanbul ignore next */
function parseArgs(argv) {
    const changedFiles = [];
    let graphPath = DEFAULT_GRAPH_PATH;
    let output = null;
    let verbose = false;
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case "--changed-files":
                // Consume all following non-flag arguments as file paths.
                while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
                    changedFiles.push(argv[++i]);
                }
                break;
            case "--graph":
                graphPath = argv[++i];
                break;
            case "--output":
                output = argv[++i];
                break;
            case "--verbose":
                verbose = true;
                break;
        }
    }
    return { changedFiles, graphPath, output, verbose };
}
/* istanbul ignore next */
function main() {
    const { changedFiles, graphPath, output, verbose } = parseArgs(process.argv.slice(2));
    const result = selectTests(changedFiles, graphPath);
    if (verbose) {
        if (result.kind === "full_run") {
            console.error(`[select-tests] full run — ${result.reason}`);
        }
        else {
            console.error(`[select-tests] selected ${result.tests.length} test file(s)`);
        }
    }
    const text = result.kind === "full_run"
        ? FULL_RUN_SENTINEL
        : result.tests.join("\n");
    if (output) {
        fs.writeFileSync(output, text + "\n", "utf-8");
        if (verbose)
            console.error(`[select-tests] wrote output to ${output}`);
    }
    else {
        process.stdout.write(text + "\n");
    }
}
// Only run when invoked directly (not when imported in tests).
/* istanbul ignore next */
const isMain = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace(/^file:\/\/\/?/, "").replace(/^([A-Za-z]:)/, (m) => m.toUpperCase()));
if (isMain) {
    main();
}
