/**
 * dispute.ts
 * ----------
 * Domain types for the dispute / appeal workflow. The dispute surface lives
 * in src/routes/admin.ts (mock for E2E) and is extended here to model the
 * senior-panel appeal workflow:
 *
 *   OPEN → EVIDENCED → ADJUDICATED → APPEALED → SENIOR_REVIEW → FINAL
 *
 * State transitions are enforced by src/services/disputeAppeals.ts which
 * also computes a SHA-256 hash chain on every status change so an
 * investigator can replay the dispute lifecycle from the chain alone.
 */

export type DisputeStatus =
  | "OPEN"
  | "EVIDENCED"
  | "ADJUDICATED"
  | "APPEALED"
  | "SENIOR_REVIEW"
  | "FINAL"
  | "CLOSED"
  | "TIMEOUT";

/**
 * One link in the finality hash chain. Appended in order whenever the
 * dispute's status changes; the FINAL state MUST carry a chain whose
 * terminal hash is recomputable from `chain[0].prevHash` and the record
 * at each link.
 */
export interface FinalityRecord {
  /** SHA-256 hex of the previous chain link, or null on the genesis link. */
  prevHash: string | null;
  /** SHA-256 hex of this link. */
  hash: string;
  /** Status the dispute held immediately when this link was appended. */
  status: DisputeStatus;
  /** Unix epoch ms at the moment the link was appended. */
  at: number;
  /**
   * Deterministic canonical JSON of the payload bound into the chain.
   * Never include non-serialisable fields here — the hash must be
   * recomputable from this shape.
   */
  payload: Record<string, unknown>;
}

export interface SeniorArbiter {
  id: string;
  /** Tenant the senior arbiter is affiliated with; used for COI checks. */
  tenantId: string;
  name?: string;
}

export interface SeniorPanelVote {
  arbiterId: string;
  vote: "UPHOLD" | "OVERTURN";
  rationale?: string;
  at: number;
}

export interface Dispute {
  id: string;
  status: DisputeStatus;
  buyerId: string;
  supplierId: string;
  /**
   * Tenant affiliations of the buyer and supplier. Senior arbiters
   * affiliated with either tenant are excluded from appeal panels
   * automatically; the `tenantId` defaults to the buyer/supplier id when
   * the create endpoint receives no explicit value, but production
   * callers SHOULD supply real tenant ids.
   */
  buyerTenantId: string;
  supplierTenantId: string;
  amount: number;
  evidence: string[];
  ruling?: string;
  arbiter?: string;
  adjudicatedAt?: number;
  /** Hash of the most recent chain link, or null if no link has been written. */
  finalityHash: string | null;
  /** Ordered chain of transitions; finalityHash === chain[chain.length - 1].hash. */
  finalityChain: FinalityRecord[];
  /** Window length (ms) within which an appeal is accepted after adjudication. */
  appealWindowMs?: number;
  /** Wall-clock ms when an appeal was successfully initiated. */
  appealInitiatedAt?: number;
  /** Senior panel selected at appeal initiation; immutable thereafter. */
  panel?: SeniorArbiter[];
  /** Votes cast by the panel; an empty array implies the FINAL transition is blocked. */
  panelVotes?: SeniorPanelVote[];
  /** Wall-clock ms when the senior panel's decision was finalised. */
  seniorDecisionAt?: number;
  /** Final ruling from the senior panel; may overturn or uphold the original. */
  finalRuling?: "UPHELD" | "OVERTURNED";

  // ── Auto-resolution fields ──────────────────────────────────────────────
  /** Wall-clock ms when auto-resolution was applied by the deadline scheduler. */
  autoResolvedAt?: number;
  /**
   * Window length (ms) within which an auto-resolution can be reversed.
   * Defaults to `DEFAULT_AUTO_RESOLVE_REVERSAL_WINDOW_MS` (24 h).
   */
  autoResolveWindowMs?: number;
}
