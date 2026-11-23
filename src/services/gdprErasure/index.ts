/**
 * GDPR Erasure Orchestrator — public API
 *
 * Re-exports the types and classes that consumers need.
 */

export type { ErasureRequest, ErasureResult, LegalHoldChecker, DbPool } from "./GdprErasureOrchestrator.js";
export { GdprErasureOrchestrator, LegalHoldViolationError, defaultGdprErasureOrchestrator } from "./GdprErasureOrchestrator.js";

export type { ErasureReceipt, TableErasureSummary, ErasureEventLog } from "./eventLog.js";
export { PgErasureEventLog, InMemoryErasureEventLog } from "./eventLog.js";

export type { TableNode, PiiColumn } from "./dependencyGraph.js";
export { PII_TABLE_GRAPH, topoSort, getSortedGraph, CircularDependencyError, UnknownDependencyError } from "./dependencyGraph.js";

export type { TombstoneAction, TableTombstoneResult, TombstoneOptions } from "./tombstone.js";
export { tombstoneTable, sha256Hex } from "./tombstone.js";
