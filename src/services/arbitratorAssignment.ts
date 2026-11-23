/**
 * arbitratorAssignment.ts
 * -------------------------
 * Conflict-of-interest (COI) aware arbitrator assignment engine.
 *
 * Responsibilities:
 *   1. Maintain a COI relations table with three signal types:
 *      SHARED_TENANT  – arbitrator belongs to the same tenant as a party.
 *      PRIOR_TRANSACTION – arbitrator has processed a prior transaction
 *        involving the party within a configurable lookback window.
 *      KNOWN_AFFILIATION – explicit affiliation record (e.g. family
 *        member, former employer, board membership).
 *   2. Filter the arbitrator pool to remove:
 *        - Offline arbitrators
 *        - Arbitrators with any active COI signal against buyer or supplier
 *   3. Load-balance the eligible set using a round-robin counter so that
 *      assignments are spread evenly over time.
 *   4. Log every skip reason to the audit log so the assignment trail is
 *      fully replayable.
 *
 * The engine is framework-agnostic and can be exercised without a running
 * Express app. An in-memory COI lookup implementation is provided for
 * tests and development; production deployments SHOULD replace it with a
 * database-backed adapter that respects the same interface.
 *
 * Usage:
 *   const engine = new RoundRobinArbitratorAssignmentEngine();
 *   engine.coiLookupService.addRelation({...});
 *   const result = await engine.assignArbitrator(
 *     { disputeId: "d-1", buyerId: "b-1", supplierId: "s-1" },
 *     pool,
 *   );
 *   // result.assigned?.id  → the selected arbitrator, or null
 *   // result.skipped       → reasons each skipped arbitrator was excluded
 */

import { defaultAuditLogger } from "./auditLogger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three COI signal types the lookup service can return. */
export type CoiSignal = "SHARED_TENANT" | "PRIOR_TRANSACTION" | "KNOWN_AFFILIATION";

/** A single COI relation between an arbitrator and a dispute party. */
export interface CoiRelation {
  /** Arbitrator who has the conflict. */
  arbitratorId: string;
  /** Party (buyer or supplier) the arbitrator is conflicted with. */
  partyId: string;
  /** Which side of the dispute the party is on. */
  partyType: "buyer" | "supplier";
  /** The type of signal detected. */
  signal: CoiSignal;
  /** Human-readable explanation (e.g. "Shared tenant neutral-A"). */
  reason: string;
}

/** Result of a COI lookup for a single arbitrator against both parties. */
export interface CoiLookupResult {
  /** True when at least one COI signal exists. */
  hasConflict: boolean;
  /** All matching COI relations found. */
  signals: CoiRelation[];
}

/**
 * Abstraction for the COI data store. The in-memory implementation is
 * suitable for tests and low-volume development; production callers
 * should provide a database-backed adapter.
 */
export interface CoiLookupService {
  /** Return all COI signals involving `arbitratorId` AND (`buyerId` or `supplierId`). */
  getConflicts(
    arbitratorId: string,
    buyerId: string,
    supplierId: string,
  ): Promise<CoiLookupResult>;

  /** Register a new COI relation. */
  addRelation(relation: CoiRelation): void;

  /** Remove all relations for a given arbitrator (e.g. on departure). */
  removeRelationsFor(arbitratorId: string): void;

  /** Remove all relations (test isolation / full reset). */
  clear(): void;
}

/** An arbitrator available for assignment. */
export interface Arbitrator {
  /** Unique identifier (e.g. "arb-alice"). */
  id: string;
  /** Display name. */
  name: string;
  /** Tenant the arbitrator belongs to (used for SHARED_TENANT COI). */
  tenantId: string;
  /** Whether the arbitrator is currently accepting new assignments. */
  isOnline: boolean;
}

/** Input describing the dispute an arbitrator is needed for. */
export interface AssignArbitratorInput {
  disputeId: string;
  buyerId: string;
  supplierId: string;
}

/** One skipped arbitrator and the reason they were excluded. */
export interface SkipLogEntry {
  arbitratorId: string;
  /** Machine-readable reason code. */
  reason: "ARBITRATOR_OFFLINE" | "CONFLICT_OF_INTEREST";
  /** COI signals that triggered the exclusion (empty for OFFLINE). */
  signals: CoiRelation[];
}

/** Final result of an assignment attempt. */
export interface ArbitratorAssignmentResult {
  /** The selected arbitrator, or null if no eligible candidate was found. */
  assigned: Arbitrator | null;
  /** Every candidate that was skipped and why. */
  skipped: SkipLogEntry[];
  /** The round-robin counter value used for this assignment. */
  roundRobinIndex: number;
}

// ---------------------------------------------------------------------------
// In-memory COI lookup service
// ---------------------------------------------------------------------------

export class InMemoryCoiLookupService implements CoiLookupService {
  private relations: CoiRelation[] = [];

  async getConflicts(
    arbitratorId: string,
    buyerId: string,
    supplierId: string,
  ): Promise<CoiLookupResult> {
    const matching = this.relations.filter(
      (r) =>
        r.arbitratorId === arbitratorId &&
        (r.partyId === buyerId || r.partyId === supplierId),
    );
    return { hasConflict: matching.length > 0, signals: matching };
  }

  addRelation(relation: CoiRelation): void {
    this.relations.push(relation);
  }

  removeRelationsFor(arbitratorId: string): void {
    this.relations = this.relations.filter(
      (r) => r.arbitratorId !== arbitratorId,
    );
  }

  clear(): void {
    this.relations = [];
  }
}

// ---------------------------------------------------------------------------
// Round-robin arbitrator assignment engine
// ---------------------------------------------------------------------------

export class RoundRobinArbitratorAssignmentEngine {
  private roundRobinIndex = 0;
  private readonly coiService: CoiLookupService;

  /**
   * @param coiService  COI lookup adapter. Defaults to `InMemoryCoiLookupService`.
   * @param logger      Audit logger. Defaults to the app-wide `defaultAuditLogger`.
   */
  constructor(
    coiService?: CoiLookupService,
    private readonly logger: typeof defaultAuditLogger = defaultAuditLogger,
  ) {
    this.coiService = coiService ?? new InMemoryCoiLookupService();
  }

  /** Expose the COI service so callers can register relations. */
  get coiLookupService(): CoiLookupService {
    return this.coiService;
  }

  /** Reset the round-robin counter to zero (useful for test isolation). */
  resetRoundRobin(): void {
    this.roundRobinIndex = 0;
  }

  /**
   * Return the current round-robin counter value without modifying it.
   * Useful for diagnostics and for reconstructing which index would be
   * used on the next call.
   */
  getRoundRobinIndex(): number {
    return this.roundRobinIndex;
  }

  /**
   * Assign an arbitrator to a dispute.
   *
   * Filtering order (short-circuit, no unnecessary COI lookups):
   *   1. Skip offline arbitrators immediately.
   *   2. Look up COI signals for the remaining candidates.
   *   3. Skip any arbitrator with at least one active COI signal.
   *   4. Round-robin among the eligible set.
   *
   * Every skipped candidate is logged to the audit trail so operators
   * can replay the assignment decision later.
   */
  async assignArbitrator(
    dispute: AssignArbitratorInput,
    pool: ReadonlyArray<Arbitrator>,
  ): Promise<ArbitratorAssignmentResult> {
    const skipped: SkipLogEntry[] = [];
    const eligible: Arbitrator[] = [];

    for (const arb of pool) {
      // 1. Skip offline arbitrators
      if (!arb.isOnline) {
        skipped.push({
          arbitratorId: arb.id,
          reason: "ARBITRATOR_OFFLINE",
          signals: [],
        });
        continue;
      }

      // 2. Look up COI signals
      const coi = await this.coiService.getConflicts(
        arb.id,
        dispute.buyerId,
        dispute.supplierId,
      );

      // 3. Skip if any COI signal found
      if (coi.hasConflict) {
        skipped.push({
          arbitratorId: arb.id,
          reason: "CONFLICT_OF_INTEREST",
          signals: coi.signals,
        });
        continue;
      }

      // 4. Passes all checks
      eligible.push(arb);
    }

    // ── Audit: log every skip reason ───────────────────────────────────
    for (const skip of skipped) {
      void this.logger.log(
        "ARBITRATOR_SKIPPED",
        {
          context: {
            disputeId: dispute.disputeId,
            arbitratorId: skip.arbitratorId,
            reason: skip.reason,
            signals: skip.signals.map((s) => ({
              signal: s.signal,
              partyId: s.partyId,
              partyType: s.partyType,
              reason: s.reason,
            })),
          },
        },
        { resource: `dispute:${dispute.disputeId}`, status: "skipped" },
      );
    }

    // No eligible candidates → return null assignment
    if (eligible.length === 0) {
      return {
        assigned: null,
        skipped,
        roundRobinIndex: this.roundRobinIndex,
      };
    }

    // ── Round-robin selection ──────────────────────────────────────────
    const selectedIndex = this.roundRobinIndex % eligible.length;
    this.roundRobinIndex =
      this.roundRobinIndex < Number.MAX_SAFE_INTEGER
        ? this.roundRobinIndex + 1
        : 0;

    const assigned = eligible[selectedIndex];

    // ── Audit: log successful assignment ───────────────────────────────
    void this.logger.log(
      "ARBITRATOR_ASSIGNED",
      {
        context: {
          disputeId: dispute.disputeId,
          arbitratorId: assigned.id,
          eligibleCount: eligible.length,
          skippedCount: skipped.length,
        },
      },
      { resource: `dispute:${dispute.disputeId}`, status: "assigned" },
    );

    return {
      assigned,
      skipped,
      roundRobinIndex: this.roundRobinIndex - 1,
    };
  }
}
