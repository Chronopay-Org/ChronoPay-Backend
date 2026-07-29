/**
 * disputeDeadlineService.ts
 * ---------------------------
 * Pure business logic for the dispute deadline scheduler.
 *
 * The service is framework-agnostic so it can be exercised without a
 * running Express app. It depends only on the `Dispute` type, the
 * `canTransition` / `appendFinalityLink` helpers from `disputeAppeals`,
 * and the `auditLogger` for emitting audit events.
 *
 * ## Auto-resolution rules
 *
 * | Current status     | Target status | Condition                                          |
 * |--------------------|---------------|----------------------------------------------------|
 * | OPEN               | TIMEOUT       | No chain link created within INACTIVITY_TIMEOUT_MS |
 * | EVIDENCED          | TIMEOUT       | No chain link created within INACTIVITY_TIMEOUT_MS |
 * | ADJUDICATED        | CLOSED        | `adjudicatedAt + appealWindowMs` has passed        |
 * | APPEALED           | CLOSED        | `appealInitiatedAt + SENIOR_REVIEW_TIMEOUT_MS`     |
 * | SENIOR_REVIEW      | CLOSED        | `appealInitiatedAt + SENIOR_REVIEW_TIMEOUT_MS`     |
 *
 * ## Reversibility
 *
 * Every auto-resolution records `autoResolvedAt` and an optional
 * `autoResolveWindowMs`. Within that window an admin can call the
 * reversal endpoint to reopen the dispute at its prior status.
 */

import type { Dispute, DisputeStatus } from "../types/dispute.js";
import { canTransition, appendFinalityLink } from "./disputeAppeals.js";
import { defaultAuditLogger } from "./auditLogger.js";

// ---------------------------------------------------------------------------
// Default configuration constants
// ---------------------------------------------------------------------------

/**
 * Grace period after the last activity on an OPEN / EVIDENCED dispute before
 * the scheduler auto-resolves it to TIMEOUT. Default 30 days.
 */
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Grace period after appeal initiation (APPEALED / SENIOR_REVIEW) before the
 * scheduler auto-resolves the dispute to TIMEOUT. Default 14 days.
 */
export const DEFAULT_SENIOR_REVIEW_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Window within which an auto-resolution can be reversed by an admin.
 * Default 24 hours.
 */
export const DEFAULT_AUTO_RESOLVE_REVERSAL_WINDOW_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Scan result types
// ---------------------------------------------------------------------------

export interface AutoResolvedDispute {
  disputeId: string;
  fromStatus: DisputeStatus;
  toStatus: DisputeStatus;
  ruling: string;
  /** Unix epoch ms when the auto-resolution was applied. */
  resolvedAt: number;
}

export interface ScanResult {
  /** Disputes that were auto-resolved during this scan. */
  resolved: AutoResolvedDispute[];
  /** Number of disputes that were scanned but did not require action. */
  skipped: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the default ruling for an auto-resolved dispute based on its
 * last-known state before the grace window expired.
 *
 * - OPEN / EVIDENCED timed out → no ruling (both parties inactive).
 * - ADJUDICATED closed → the adjudicated ruling stands.
 * - APPEALED / SENIOR_REVIEW closed → the original adjudicated ruling
 *   stands (the appealing party failed to pursue the appeal).
 */
function defaultRulingFor(dispute: Dispute): string {
  if (dispute.status === "ADJUDICATED" || dispute.status === "APPEALED" || dispute.status === "SENIOR_REVIEW") {
    return dispute.ruling ?? "NO_RULING_AVAILABLE";
  }
  // OPEN or EVIDENCED → TIMEOUT: neither party was active enough to push
  // the dispute forward, so we record a neutral timeout.
  return "TIMEOUT_NO_ACTIVITY";
}

/**
 * Return the last activity timestamp from the finality chain, or 0 if the
 * chain is empty. This is used to measure inactivity on OPEN / EVIDENCED
 * disputes that have never been adjudicated.
 */
function lastActivityAt(dispute: Dispute): number | null {
  if (dispute.finalityChain.length > 0) {
    return dispute.finalityChain[dispute.finalityChain.length - 1].at;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scanner logic
// ---------------------------------------------------------------------------

export interface DisputeDeadlineServiceOptions {
  /** Inactivity timeout for OPEN / EVIDENCED disputes. */
  inactivityTimeoutMs?: number;
  /** Timeout for unresolved appeals (APPEALED / SENIOR_REVIEW). */
  seniorReviewTimeoutMs?: number;
  /** Window within which an auto-resolution can be reversed. */
  autoResolveWindowMs?: number;
  /** Clock function; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Scan a list of disputes and auto-resolve those that have exceeded their
 * respective grace windows.
 *
 * @param disputes - The current in-memory dispute map values.
 * @param options  - Optional configuration overrides.
 * @returns A `ScanResult` describing which disputes were resolved.
 */
export function scanAndAutoResolve(
  disputes: ReadonlyArray<Dispute>,
  options: DisputeDeadlineServiceOptions = {},
): ScanResult {
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
  const seniorReviewTimeoutMs = options.seniorReviewTimeoutMs ?? DEFAULT_SENIOR_REVIEW_TIMEOUT_MS;
  const autoResolveWindowMs = options.autoResolveWindowMs ?? DEFAULT_AUTO_RESOLVE_REVERSAL_WINDOW_MS;
  const now = options.now?.() ?? Date.now();

  const resolved: AutoResolvedDispute[] = [];
  let skipped = 0;

  for (const dispute of disputes) {
    // Skip disputes already in a terminal state or already auto-resolved.
    if (dispute.status === "FINAL" || dispute.status === "CLOSED" || dispute.status === "TIMEOUT") {
      skipped++;
      continue;
    }
    if (dispute.autoResolvedAt) {
      skipped++;
      continue;
    }

    let targetStatus: DisputeStatus | null = null;
    let reason = "";

    switch (dispute.status) {
      case "OPEN":
      case "EVIDENCED": {
        const lastActive = lastActivityAt(dispute);
        // Skip disputes with no chain activity at all — they were just created
        // and have not had enough time to accumulate a meaningful history.
        if (lastActive === null) {
          skipped++;
          continue;
        }
        if (now - lastActive >= inactivityTimeoutMs) {
          targetStatus = "TIMEOUT";
          reason = `dispute inactive for ${((now - lastActive) / (24 * 60 * 60 * 1000)).toFixed(1)} days without progress`;
        }
        break;
      }

      case "ADJUDICATED": {
        const adjudicatedAt = dispute.adjudicatedAt ?? 0;
        const appealWindow = dispute.appealWindowMs ?? 72 * 60 * 60 * 1000; // default 72h
        if (now - adjudicatedAt >= appealWindow) {
          targetStatus = "CLOSED";
          reason = `appeal window (${(appealWindow / (60 * 60 * 1000)).toFixed(0)}h) expired without appeal`;
        }
        break;
      }

      case "APPEALED":
      case "SENIOR_REVIEW": {
        const initiatedAt = dispute.appealInitiatedAt ?? 0;
        if (now - initiatedAt >= seniorReviewTimeoutMs) {
          targetStatus = "CLOSED";
          reason = `senior review deadline (${(seniorReviewTimeoutMs / (24 * 60 * 60 * 1000)).toFixed(0)}d) elapsed without final decision`;
        }
        break;
      }

      default:
        // Unknown status – skip.
        skipped++;
        continue;
    }

    if (!targetStatus || !canTransition(dispute.status, targetStatus)) {
      skipped++;
      continue;
    }

    // Capture the original status BEFORE any mutation.
    const fromStatus = dispute.status;

    // ── Apply the auto-resolution ────────────────────────────────────────
    const at = now;
    const ruling = defaultRulingFor(dispute);
    const link = appendFinalityLink(
      dispute,
      targetStatus,
      {
        autoResolved: true,
        reason,
        ruling,
        autoResolveWindowMs,
      },
      at,
    );

    const updated = dispute as Dispute & { status: DisputeStatus; finalityHash: string | null; finalityChain: Array<unknown> };
    updated.status = targetStatus;
    updated.finalityHash = link.hash;
    updated.finalityChain.push(link);
    updated.autoResolvedAt = at;
    updated.autoResolveWindowMs = autoResolveWindowMs;

    // Emit audit event (using captured fromStatus, not the mutated dispute.status).
    void defaultAuditLogger.log(
      "DISPUTE_AUTO_RESOLVED",
      {
        body: {
          disputeId: dispute.id,
          fromStatus,
          toStatus: targetStatus,
          ruling,
          reason,
        },
        context: {
          autoResolveWindowMs,
          resolvedAt: at,
        },
      },
      {
        resource: `dispute:${dispute.id}`,
        status: "auto_resolved",
      },
    );

    resolved.push({
      disputeId: dispute.id,
      fromStatus,
      toStatus: targetStatus,
      ruling,
      resolvedAt: at,
    });
  }

  return { resolved, skipped };
}

// ---------------------------------------------------------------------------
// Reversal logic
// ---------------------------------------------------------------------------

export type ReversalErrorCode =
  | "NOT_AUTO_RESOLVED"
  | "REVERSAL_WINDOW_EXPIRED"
  | "INVALID_STATE"
  | "DISPUTE_NOT_FOUND";

export interface ReversalError {
  code: ReversalErrorCode;
  message: string;
}

export interface ReversalResult {
  reversed: boolean;
  dispute: Dispute | null;
  error?: ReversalError;
}

/**
 * Attempt to reverse an auto-resolution for a dispute. A reversal is only
 * valid if:
 *   1. The dispute was previously auto-resolved (`autoResolvedAt` set).
 *   2. The current time is within the reversal window.
 *   3. The dispute is in a terminal TIMEOUT or CLOSED state.
 *
 * On success the dispute is reopened at the status it held immediately
 * before the auto-resolution was applied (derived from the hash chain).
 *
 * @param disputes - The current in-memory dispute map.
 * @param disputeId - The dispute to reverse.
 * @param options - Optional clock / window overrides.
 */
export function reverseAutoResolve(
  disputes: ReadonlyMap<string, Dispute>,
  disputeId: string,
  options: { now?: () => number } = {},
): ReversalResult {
  const now = options.now?.() ?? Date.now();
  const dispute = disputes.get(disputeId);

  if (!dispute) {
    return {
      reversed: false,
      dispute: null,
      error: { code: "DISPUTE_NOT_FOUND", message: `Dispute ${disputeId} not found` },
    };
  }

  if (!dispute.autoResolvedAt) {
    return {
      reversed: false,
      dispute,
      error: { code: "NOT_AUTO_RESOLVED", message: "Dispute was not auto-resolved" },
    };
  }

  const windowMs = dispute.autoResolveWindowMs ?? DEFAULT_AUTO_RESOLVE_REVERSAL_WINDOW_MS;
  if (now - dispute.autoResolvedAt > windowMs) {
    return {
      reversed: false,
      dispute,
      error: {
        code: "REVERSAL_WINDOW_EXPIRED",
        message: `Reversal window of ${(windowMs / (60 * 60 * 1000)).toFixed(0)}h has expired`,
      },
    };
  }

  if (dispute.status !== "TIMEOUT" && dispute.status !== "CLOSED") {
    return {
      reversed: false,
      dispute,
      error: {
        code: "INVALID_STATE",
        message: `Cannot reverse auto-resolution from state ${dispute.status}`,
      },
    };
  }

  // Determine the prior status from the hash chain (the link before last).
  const chain = dispute.finalityChain;
  let priorStatus: DisputeStatus = "OPEN";
  if (chain.length >= 2) {
    priorStatus = chain[chain.length - 2].status as DisputeStatus;
  } else if (chain.length === 1) {
    priorStatus = chain[0].status as DisputeStatus;
  }

  // Rebuild the reversal link.
  const at = now;
  const reversalLink = appendFinalityLink(
    dispute,
    priorStatus,
    {
      autoResolveReversed: true,
      reversedAt: at,
      previousAutoResolvedAt: dispute.autoResolvedAt,
    },
    at,
  );

  const updated = dispute as Dispute & { status: DisputeStatus; finalityHash: string | null; finalityChain: Array<unknown> };
  updated.status = priorStatus;
  updated.finalityHash = reversalLink.hash;
  updated.finalityChain.push(reversalLink);
  updated.autoResolvedAt = undefined;
  updated.autoResolveWindowMs = undefined;

  // Emit audit event.
  void defaultAuditLogger.log(
    "DISPUTE_AUTO_RESOLVE_REVERSED",
    {
      body: {
        disputeId: dispute.id,
        restoredStatus: priorStatus,
        reversedAt: at,
      },
      context: {
        previousAutoResolvedAt: dispute.autoResolvedAt,
      },
    },
    {
      resource: `dispute:${dispute.id}`,
      status: "reversed",
    },
  );

  return {
    reversed: true,
    dispute: updated,
  };
}
