/**
 * dependencyGraph.ts
 *
 * Defines and validates the FK dependency graph used by the GDPR erasure
 * orchestrator to determine the safe tombstone order.
 *
 * ## Design
 *
 * Each `TableNode` describes a table that holds PII for a given subject, the
 * column used to find the subject's rows (FK or PK), and the PII columns that
 * must be tombstoned.
 *
 * A topological sort (leaf nodes first, root last) guarantees that dependent
 * rows are processed before their parent, avoiding FK constraint violations
 * when a cascade-delete policy is absent or when we want to preserve the
 * structural skeleton.
 *
 * Circular FK detection is performed by the sort itself: if a cycle is found a
 * `CircularDependencyError` is thrown before any database mutation occurs.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Describes a PII column that participates in tombstoning.
 */
export interface PiiColumn {
  /** Column name in the database table. */
  name: string;
  /**
   * When true the tombstone stores the SHA-256 hash of the original value in
   * a sibling `hash_<name>` column.  Set to false for columns where even the
   * hash would be a GDPR risk (e.g. raw address lines).
   */
  storeHash: boolean;
}

/**
 * Describes a table node in the FK dependency graph.
 */
export interface TableNode {
  /** Logical table identifier used in receipts and logs. */
  table: string;
  /** Primary-key column of this table (typically "id"). */
  pkCol: string;
  /**
   * Column used to filter rows belonging to the erasure subject.
   * Usually a foreign key to `users.id` (e.g. `customer_id`, `user_id`).
   * For the `users` table itself this is the PK (`id`).
   */
  fkCol: string;
  /** PII columns to tombstone in this table. */
  piiColumns: PiiColumn[];
  /**
   * IDs of tables that must be tombstoned **before** this table.
   * Expressed as table names (matching `TableNode.table`).
   */
  dependsOn: string[];
}

// ─── Graph definition ─────────────────────────────────────────────────────────

/**
 * The canonical FK dependency graph for ChronoPay PII tables.
 *
 * Ordering contract: tables with no dependents (leaves) come first; the
 * `users` root row is processed last so that its FK dependents are already
 * tombstoned when we reach it.
 *
 * To add a new table: append an entry and list any tables whose rows must be
 * tombstoned before this one in `dependsOn`.
 */
export const PII_TABLE_GRAPH: TableNode[] = [
  {
    table: "checkout_sessions",
    pkCol: "id",
    fkCol: "customer_id",
    piiColumns: [
      { name: "customer_email", storeHash: true },
      { name: "customer_name", storeHash: true },
      { name: "billing_address", storeHash: false },
    ],
    dependsOn: [],
  },
  {
    table: "booking_intents",
    pkCol: "id",
    fkCol: "customer_id",
    piiColumns: [
      { name: "note", storeHash: true },
    ],
    dependsOn: [],
  },
  {
    table: "users",
    pkCol: "id",
    fkCol: "id",
    piiColumns: [
      { name: "email", storeHash: true },
      { name: "name", storeHash: true },
    ],
    // Users can only be tombstoned after all dependent tables.
    dependsOn: ["checkout_sessions", "booking_intents"],
  },
];

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown when a circular FK dependency is detected in the graph.
 */
export class CircularDependencyError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Circular FK dependency detected: ${cycle.join(" → ")}`);
    this.name = "CircularDependencyError";
  }
}

/**
 * Thrown when a node references an unknown table in its `dependsOn` list.
 */
export class UnknownDependencyError extends Error {
  constructor(table: string, unknown: string) {
    super(`Table "${table}" depends on unknown table "${unknown}"`);
    this.name = "UnknownDependencyError";
  }
}

// ─── Topological sort ─────────────────────────────────────────────────────────

/**
 * Return the nodes sorted in topological order (leaves first, roots last).
 *
 * Uses iterative DFS with a grey/black visited set to detect cycles.
 *
 * @throws {UnknownDependencyError} if `dependsOn` references a table not in
 *   the graph.
 * @throws {CircularDependencyError} if a cycle is detected.
 */
export function topoSort(nodes: TableNode[]): TableNode[] {
  const byName = new Map<string, TableNode>(nodes.map((n) => [n.table, n]));

  // Validate all dependency references exist.
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!byName.has(dep)) {
        throw new UnknownDependencyError(node.table, dep);
      }
    }
  }

  const WHITE = 0; // unvisited
  const GREY = 1;  // in current DFS path (cycle detection)
  const BLACK = 2; // fully processed

  const state = new Map<string, 0 | 1 | 2>(nodes.map((n) => [n.table, WHITE]));
  const path: string[] = [];
  const result: TableNode[] = [];

  function visit(name: string): void {
    const color = state.get(name)!;
    if (color === BLACK) return;
    if (color === GREY) {
      // Find the cycle start in path.
      const cycleStart = path.indexOf(name);
      throw new CircularDependencyError([...path.slice(cycleStart), name]);
    }

    state.set(name, GREY);
    path.push(name);

    const node = byName.get(name)!;
    // Visit dependencies first (they must come before this node in the output).
    for (const dep of node.dependsOn) {
      visit(dep);
    }

    path.pop();
    state.set(name, BLACK);
    result.push(node);
  }

  for (const node of nodes) {
    if (state.get(node.table) === WHITE) {
      visit(node.table);
    }
  }

  // Standard DFS post-order: a node is pushed to `result` AFTER all its
  // dependencies have been pushed.  So `result` already has leaves first and
  // roots last — exactly the order we need (process FK dependents before the
  // parent they reference).
  //
  // No reversal needed.
  return result;
}

/**
 * Returns the ordered list of table nodes for the canonical PII graph.
 *
 * Memoised after first call.
 */
let _sortedGraph: TableNode[] | undefined;

export function getSortedGraph(): TableNode[] {
  if (!_sortedGraph) {
    _sortedGraph = topoSort(PII_TABLE_GRAPH);
  }
  return _sortedGraph;
}

/**
 * Reset the memoised graph (for testing only).
 * @internal
 */
export function _resetSortedGraph(): void {
  _sortedGraph = undefined;
}
