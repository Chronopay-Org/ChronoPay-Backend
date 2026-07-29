/**
 * disputeAppeals.ts
 * ------------------
 * Pure logic for the dispute appeal workflow. The HTTP layer
 * (src/routes/admin.ts) imports the state-machine and panel-selection
 * functions here; this file is intentionally framework-agnostic so it can
 * be exercised without a running Express app.
 *
 * Three responsibilities:
 *
 * 1. State machine — `canTransition(cur, t)` enforces the allowed-status
 *    graph and `transition(...)` produces the new dispute shape.
 * 2. Hash chain — `appendFinalityLink(...)` advances the SHA-256 chain
 *    one link at a time. Tampering with any prior record breaks the
 *    recomputation, so the chain acts as a forensic seal.
 * 3. Panel selection — `selectSeniorPanel(...)` picks at least
 *    `SENIOR_PANEL_MIN_SIZE` senior arbiters that satisfy the COI rules.
 *
 * The service does NOT emit audit events. Auditing is the route layer's
 * responsibility (see admin.ts) so the audit envelope can include the
 * request's actor IP and the disambiguated resource path.
 */

import crypto from "node:crypto";
import type {
  Dispute,
  DisputeStatus,
  FinalityRecord,
  SeniorArbiter,
  SeniorPanelVote,
} from "../types/dispute.js";
import { stableStringify } from "../utils/hash.js";

/**
 * Allowed transitions. Each status key maps to the set of statuses it can
 * transition to; an empty array means the status is terminal.
 */
export const DISPUTE_STATE_TRANSITIONS: Record<DisputeStatus, DisputeStatus[]> = {
  OPEN: ["EVIDENCED", "TIMEOUT"],
  EVIDENCED: ["ADJUDICATED", "TIMEOUT"],
  ADJUDICATED: ["APPEALED", "CLOSED"],
  APPEALED: ["SENIOR_REVIEW", "CLOSED"],
  SENIOR_REVIEW: ["FINAL", "CLOSED"],
  FINAL: [],
  CLOSED: [],
  TIMEOUT: [],
};

/** Default appeal window (72 h). Override per-dispute via `appealWindowMs`. */
export const DEFAULT_APPEAL_WINDOW_MS = 72 * 60 * 60 * 1000;

/** Minimum panel size per the senior-panel workflow requirement. */
export const SENIOR_PANEL_MIN_SIZE = 3;

/**
 * Genesis hash used when a dispute has no prior finality link. 64 zero
 * hex chars matches the SHA-256 digest length so the recursion is uniform.
 */
export const FINALITY_GENESIS_HASH = "0".repeat(64);

export function canTransition(current: DisputeStatus, target: DisputeStatus): boolean {
  const allowed = DISPUTE_STATE_TRANSITIONS[current];
  return Array.isArray(allowed) && allowed.includes(target);
}

export function isWithinAppealWindow(dispute: Dispute, now: number): boolean {
  if (typeof dispute.adjudicatedAt !== "number") {
    return false;
  }
  const window = dispute.appealWindowMs ?? DEFAULT_APPEAL_WINDOW_MS;
  return now - dispute.adjudicatedAt <= window;
}

/**
 * Compute the next chain link for a transition. `payload` MUST be a
 * JSON-serialisable object so the hash is reproducible from stored data.
 * The hour-hand-on-the-wall `ts` is included so identical logical
 * transitions at different times produce distinct hashes.
 */
export function appendFinalityLink(
  dispute: Dispute,
  status: DisputeStatus,
  payload: Record<string, unknown>,
  ts: number,
): FinalityRecord {
  const prevHash = dispute.finalityHash;
  const payloadStr = JSON.stringify(stableStringify(payload));
  const raw = [
    prevHash ?? FINALITY_GENESIS_HASH,
    dispute.id,
    status,
    payloadStr,
    String(ts),
  ].join("|");
  const hash = crypto.createHash("sha256").update(raw, "utf8").digest("hex");
  return { prevHash, hash, status, at: ts, payload };
}

export interface SeniorPanelExclusion {
  arbiterId: string;
  reason: "ORIGINAL_ARBITER" | "PARTY_CONFLICT" | "APPEAL_OF_APPEAL";
}

export interface SeniorPanelSelection {
  panel: SeniorArbiter[];
  excluded: SeniorPanelExclusion[];
}

/**
 * Build a senior review panel of at least `SENIOR_PANEL_MIN_SIZE`
 * arbiters from the eligible pool, excluding:
 *   - the dispute's original arbiter (cannot review own decision),
 *   - any arbiter whose `tenantId` matches the buyer's or supplier's
 *     `tenantId` (party conflict),
 *   - any arbiter who has already served on a prior panel for the same
 *     dispute (appeal-of-appeal blocker).
 *
 * The returned panel is sorted alphabetically by `id` so two equivalent
 * selection runs (same pool + same dispute) yield the same composition —
 * helpful for test stability and audit replay.
 */
export function selectSeniorPanel(
  pool: ReadonlyArray<SeniorArbiter>,
  dispute: Dispute,
): SeniorPanelSelection {
  const excluded: SeniorPanelExclusion[] = [];
  const candidates: SeniorArbiter[] = [];

  for (const candidate of pool) {
    if (dispute.arbiter && candidate.id === dispute.arbiter) {
      excluded.push({ arbiterId: candidate.id, reason: "ORIGINAL_ARBITER" });
      continue;
    }
    if (
      candidate.tenantId === dispute.buyerTenantId ||
      candidate.tenantId === dispute.supplierTenantId
    ) {
      excluded.push({ arbiterId: candidate.id, reason: "PARTY_CONFLICT" });
      continue;
    }
    if (dispute.panel && dispute.panel.some((p) => p.id === candidate.id)) {
      excluded.push({ arbiterId: candidate.id, reason: "APPEAL_OF_APPEAL" });
      continue;
    }
    candidates.push(candidate);
  }

  candidates.sort((a, b) => a.id.localeCompare(b.id));
  return {
    panel: candidates.slice(0, SENIOR_PANEL_MIN_SIZE),
    excluded,
  };
}

export interface SeniorDecisionError {
  code:
    | "INVALID_STATE"
    | "PANEL_NOT_SET"
    | "INSUFFICIENT_VOTES"
    | "PANEL_VOTE_MISMATCH"
    | "DUPLICATE_VOTE";
  message: string;
}

/**
 * Validate that `input.votes` covers every panel member exactly once.
 * Returns the first failure as a typed error, or null on success.
 */
export function validateSeniorDecision(
  dispute: Dispute,
  input: { votes: SeniorPanelVote[] },
): SeniorDecisionError | null {
  if (dispute.status !== "SENIOR_REVIEW") {
    return {
      code: "INVALID_STATE",
      message: `Cannot issue senior decision from state ${dispute.status}`,
    };
  }
  if (!dispute.panel || dispute.panel.length === 0) {
    return { code: "PANEL_NOT_SET", message: "No senior panel assigned" };
  }
  if (input.votes.length !== dispute.panel.length) {
    return {
      code: "INSUFFICIENT_VOTES",
      message: `Expected ${dispute.panel.length} votes, got ${input.votes.length}`,
    };
  }
  const validIds = new Set(dispute.panel.map((p) => p.id));
  const seen = new Set<string>();
  for (const v of input.votes) {
    if (!validIds.has(v.arbiterId)) {
      return {
        code: "PANEL_VOTE_MISMATCH",
        message: `Vote from non-panel arbiter: ${v.arbiterId}`,
      };
    }
    if (seen.has(v.arbiterId)) {
      return {
        code: "DUPLICATE_VOTE",
        message: `Duplicate vote from arbiter ${v.arbiterId}`,
      };
    }
    seen.add(v.arbiterId);
  }
  return null;
}

/** Reduce a panel's votes to the majority outcome. */
export function decideByMajority(input: SeniorPanelVote[]): "UPHOLD" | "OVERTURN" {
  let uphold = 0;
  let overturn = 0;
  for (const v of input) {
    if (v.vote === "UPHOLD") uphold += 1;
    else overturn += 1;
  }
  return uphold >= overturn ? "UPHOLD" : "OVERTURN";
}

// ---------------------------------------------------------------------------
// In-process senior arbiter pool
// ---------------------------------------------------------------------------

/**
 * Module-level pool of senior arbiters. Co-location with this service
 * matches the pattern in admin.ts for the dispute Map so existing tests
 * can reset state between cases by calling `resetSeniorPool`.
 */
const seniorPool: Map<string, SeniorArbiter> = new Map();

export function getSeniorPool(): readonly SeniorArbiter[] {
  return Array.from(seniorPool.values());
}

export function addSeniorArbiter(arbiter: SeniorArbiter): void {
  seniorPool.set(arbiter.id, arbiter);
}

export function removeSeniorArbiter(id: string): void {
  seniorPool.delete(id);
}

/** Test isolation only — never call in production code. */
export function resetSeniorPool(): void {
  seniorPool.clear();
}
