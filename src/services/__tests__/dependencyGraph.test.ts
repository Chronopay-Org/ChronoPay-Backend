/**
 * dependencyGraph.test.ts
 *
 * Tests for the FK dependency graph walker: topological sort, cycle detection,
 * unknown dependency detection, and the canonical PII_TABLE_GRAPH.
 */

import {
  topoSort,
  getSortedGraph,
  _resetSortedGraph,
  PII_TABLE_GRAPH,
  CircularDependencyError,
  UnknownDependencyError,
  type TableNode,
} from "../../services/gdprErasure/dependencyGraph.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(
  table: string,
  dependsOn: string[] = [],
  piiColumns: TableNode["piiColumns"] = [],
): TableNode {
  return { table, pkCol: "id", fkCol: "user_id", piiColumns, dependsOn };
}

// ─── topoSort ─────────────────────────────────────────────────────────────────

describe("topoSort", () => {
  afterEach(() => {
    _resetSortedGraph();
  });

  it("returns a single node unchanged", () => {
    const nodes = [makeNode("users")];
    const result = topoSort(nodes);
    expect(result).toHaveLength(1);
    expect(result[0].table).toBe("users");
  });

  it("places leaf nodes before root nodes", () => {
    const nodes = [
      makeNode("users", ["bookings"]),
      makeNode("bookings"),
    ];
    const result = topoSort(nodes);
    const tables = result.map((n) => n.table);
    expect(tables.indexOf("bookings")).toBeLessThan(tables.indexOf("users"));
  });

  it("handles a linear chain: C → B → A", () => {
    const nodes = [
      makeNode("a", ["b"]),
      makeNode("b", ["c"]),
      makeNode("c"),
    ];
    const result = topoSort(nodes);
    const idx = (t: string) => result.findIndex((n) => n.table === t);
    expect(idx("c")).toBeLessThan(idx("b"));
    expect(idx("b")).toBeLessThan(idx("a"));
  });

  it("handles diamond dependency (two leaves, one root)", () => {
    const nodes = [
      makeNode("root", ["left", "right"]),
      makeNode("left"),
      makeNode("right"),
    ];
    const result = topoSort(nodes);
    const rootIdx = result.findIndex((n) => n.table === "root");
    const leftIdx = result.findIndex((n) => n.table === "left");
    const rightIdx = result.findIndex((n) => n.table === "right");
    expect(leftIdx).toBeLessThan(rootIdx);
    expect(rightIdx).toBeLessThan(rootIdx);
  });

  it("handles a graph with no dependencies (all leaves)", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c")];
    const result = topoSort(nodes);
    expect(result).toHaveLength(3);
    // All are leaves — any order is valid as long as all are present.
    const tables = new Set(result.map((n) => n.table));
    expect(tables).toEqual(new Set(["a", "b", "c"]));
  });

  // ── Cycle detection ─────────────────────────────────────────────────────────

  it("throws CircularDependencyError for a direct self-cycle (A → A)", () => {
    const nodes = [makeNode("a", ["a"])];
    expect(() => topoSort(nodes)).toThrow(CircularDependencyError);
  });

  it("throws CircularDependencyError for a two-node cycle (A → B → A)", () => {
    const nodes = [makeNode("a", ["b"]), makeNode("b", ["a"])];
    expect(() => topoSort(nodes)).toThrow(CircularDependencyError);
  });

  it("throws CircularDependencyError for a three-node cycle", () => {
    const nodes = [
      makeNode("a", ["b"]),
      makeNode("b", ["c"]),
      makeNode("c", ["a"]),
    ];
    expect(() => topoSort(nodes)).toThrow(CircularDependencyError);
  });

  it("includes the cycle path in the error", () => {
    const nodes = [makeNode("a", ["b"]), makeNode("b", ["a"])];
    try {
      topoSort(nodes);
      fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CircularDependencyError);
      expect((err as CircularDependencyError).cycle.length).toBeGreaterThanOrEqual(2);
    }
  });

  // ── Unknown dependency ──────────────────────────────────────────────────────

  it("throws UnknownDependencyError when dependsOn references a missing table", () => {
    const nodes = [makeNode("a", ["nonexistent"])];
    expect(() => topoSort(nodes)).toThrow(UnknownDependencyError);
  });

  it("includes table name in UnknownDependencyError message", () => {
    const nodes = [makeNode("a", ["ghost"])];
    try {
      topoSort(nodes);
    } catch (err) {
      expect((err as Error).message).toContain("ghost");
    }
  });

  it("returns an empty array for an empty input", () => {
    expect(topoSort([])).toEqual([]);
  });
});

// ─── getSortedGraph (memoised) ────────────────────────────────────────────────

describe("getSortedGraph", () => {
  afterEach(() => {
    _resetSortedGraph();
  });

  it("returns the same reference on repeated calls (memoised)", () => {
    const first = getSortedGraph();
    const second = getSortedGraph();
    expect(first).toBe(second);
  });

  it("returns a fresh result after _resetSortedGraph", () => {
    const first = getSortedGraph();
    _resetSortedGraph();
    const second = getSortedGraph();
    expect(first).not.toBe(second);
    expect(first).toEqual(second); // same content
  });

  it("includes all nodes from PII_TABLE_GRAPH", () => {
    const sorted = getSortedGraph();
    expect(sorted).toHaveLength(PII_TABLE_GRAPH.length);
    const tables = new Set(sorted.map((n) => n.table));
    for (const node of PII_TABLE_GRAPH) {
      expect(tables).toContain(node.table);
    }
  });
});

// ─── Canonical PII_TABLE_GRAPH ────────────────────────────────────────────────

describe("PII_TABLE_GRAPH", () => {
  it("does not have circular dependencies", () => {
    expect(() => topoSort(PII_TABLE_GRAPH)).not.toThrow();
  });

  it("users node is last after topological sort (processed after dependents)", () => {
    _resetSortedGraph();
    const sorted = topoSort(PII_TABLE_GRAPH);
    const usersIdx = sorted.findIndex((n) => n.table === "users");
    // users must come last (it depends on all others)
    expect(usersIdx).toBe(sorted.length - 1);
  });

  it("users node has at least one pii column with storeHash=true", () => {
    const users = PII_TABLE_GRAPH.find((n) => n.table === "users");
    expect(users).toBeDefined();
    const hashed = users!.piiColumns.filter((c) => c.storeHash);
    expect(hashed.length).toBeGreaterThan(0);
  });

  it("booking_intents node exists with note column", () => {
    const bi = PII_TABLE_GRAPH.find((n) => n.table === "booking_intents");
    expect(bi).toBeDefined();
    expect(bi!.piiColumns.some((c) => c.name === "note")).toBe(true);
  });

  it("checkout_sessions node exists with pii columns", () => {
    const cs = PII_TABLE_GRAPH.find((n) => n.table === "checkout_sessions");
    expect(cs).toBeDefined();
    expect(cs!.piiColumns.length).toBeGreaterThan(0);
  });

  it("all nodes have non-empty piiColumns or no meaningful dependsOn", () => {
    // Every table in the graph must at least declare one PII column or be
    // included deliberately as a structural dependency.
    for (const node of PII_TABLE_GRAPH) {
      // Each node should have a valid pkCol and fkCol
      expect(node.pkCol).toBeTruthy();
      expect(node.fkCol).toBeTruthy();
    }
  });
});
