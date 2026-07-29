/**
 * escrowSlashing.ts
 *
 * Escrow slashing rules for confirmed supplier fraud.
 *
 * ## Policy
 *
 * When a supplier is confirmed to have committed fraud, their escrowed stake
 * is "slashed": the forfeited funds are swept into a buyer-insurance pool
 * on-chain.
 *
 * The slashing pipeline has three stages:
 *
 *   1. Propose   – an admin creates a slashing proposal for a booking.
 *   2. Approve   – a second, distinct admin co-signs the proposal.
 *   3. Execute   – once two-admin approval is reached, any admin (or an
 *                  automated worker) calls `executeSlash`, which:
 *                  a. emits an audit log entry,
 *                  b. records the on-chain sweep (simulated here), and
 *                  c. marks the proposal as executed.
 *
 * ## Two-admin dual-control
 *
 * - The proposer and approver must be different identities.
 * - Only two approvals are required; subsequent `approveSlash` calls on an
 *   already-approved proposal throw `SlashAlreadyApprovedError`.
 * - `executeSlash` checks `requiresTwoAdminApproval()` before proceeding
 *   and throws `SlashNotApprovedError` if approval is still pending.
 *
 * ## Audit trail
 *
 * Every mutating action (propose, approve, execute) is forwarded to an
 * injected `IAuditSink`.  In production this should be wired to the
 * `AuditLogger` from `src/services/auditLogger.ts`.
 */

import crypto from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SlashProposalStatus =
  | "pending_approval"
  | "approved"
  | "executed";

export interface SlashProposal {
  proposalId: string;
  bookingId: string;
  /** Stellar account address of the fraudulent supplier. */
  supplierAddress: string;
  /** Amount to slash from the supplier's stake, in stroops. */
  slashAmountStroops: number;
  /** Stellar C-address of the buyer-insurance pool contract to receive funds. */
  insurancePoolAddress: string;
  /** Admin id that created the proposal. */
  proposedBy: string;
  /** ISO 8601 timestamp. */
  proposedAt: string;
  /** Admin id that approved the proposal (different from proposer). */
  approvedBy?: string;
  /** ISO 8601 timestamp. */
  approvedAt?: string;
  /** Stellar tx hash of the on-chain sweep, once executed. */
  sweepTxHash?: string;
  /** ISO 8601 timestamp. */
  executedAt?: string;
  status: SlashProposalStatus;
  /** Free-form fraud evidence / reason. */
  fraudReason: string;
}

export interface SlashResult {
  proposalId: string;
  sweepTxHash: string;
  slashAmountStroops: number;
  insurancePoolAddress: string;
}

// ─── Audit sink ───────────────────────────────────────────────────────────────

export interface IAuditSink {
  log(action: string, data: Record<string, unknown>): Promise<void>;
}

/** No-op sink used in unit tests that don't care about audit output. */
export const NULL_AUDIT_SINK: IAuditSink = {
  log: async () => undefined,
};

// ─── Errors ───────────────────────────────────────────────────────────────────

export class SlashProposalNotFoundError extends Error {
  constructor(public readonly proposalId: string) {
    super(`Slash proposal not found: ${proposalId}`);
    this.name = "SlashProposalNotFoundError";
  }
}

export class SlashSelfApprovalError extends Error {
  constructor(public readonly adminId: string) {
    super(
      `Admin "${adminId}" cannot approve their own slash proposal. ` +
        `A second, distinct admin is required.`,
    );
    this.name = "SlashSelfApprovalError";
  }
}

export class SlashAlreadyApprovedError extends Error {
  constructor(public readonly proposalId: string) {
    super(`Slash proposal "${proposalId}" is already approved.`);
    this.name = "SlashAlreadyApprovedError";
  }
}

export class SlashNotApprovedError extends Error {
  constructor(public readonly proposalId: string) {
    super(
      `Slash proposal "${proposalId}" has not reached the required two-admin approval.`,
    );
    this.name = "SlashNotApprovedError";
  }
}

export class SlashAlreadyExecutedError extends Error {
  constructor(public readonly proposalId: string) {
    super(`Slash proposal "${proposalId}" has already been executed.`);
    this.name = "SlashAlreadyExecutedError";
  }
}

export class InvalidSlashAmountError extends Error {
  constructor(public readonly amountStroops: number) {
    super(
      `Slash amount must be a positive integer in stroops, got: ${amountStroops}`,
    );
    this.name = "InvalidSlashAmountError";
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Manages the full lifecycle of a supplier slash proposal from proposal
 * through dual-control approval to on-chain treasury sweep.
 */
export class EscrowSlashingService {
  private readonly proposals = new Map<string, SlashProposal>();

  constructor(
    private readonly auditSink: IAuditSink = NULL_AUDIT_SINK,
    private readonly nowFn: () => string = () => new Date().toISOString(),
  ) {}

  // ── Stage 1: Propose ──────────────────────────────────────────────────────

  /**
   * Create a new slash proposal for a booking.
   *
   * Only an authorised admin should call this; enforce upstream with
   * `requireAuthenticatedActor(["admin"])`.
   */
  async proposeSlash(params: {
    bookingId: string;
    supplierAddress: string;
    slashAmountStroops: number;
    insurancePoolAddress: string;
    proposedBy: string;
    fraudReason: string;
  }): Promise<SlashProposal> {
    if (!Number.isInteger(params.slashAmountStroops) || params.slashAmountStroops <= 0) {
      throw new InvalidSlashAmountError(params.slashAmountStroops);
    }

    const proposalId = crypto.randomUUID();
    const proposal: SlashProposal = {
      proposalId,
      bookingId: params.bookingId,
      supplierAddress: params.supplierAddress,
      slashAmountStroops: params.slashAmountStroops,
      insurancePoolAddress: params.insurancePoolAddress,
      proposedBy: params.proposedBy,
      proposedAt: this.nowFn(),
      fraudReason: params.fraudReason,
      status: "pending_approval",
    };

    this.proposals.set(proposalId, proposal);

    await this.auditSink.log("escrow.slash.proposed", {
      proposalId,
      bookingId: params.bookingId,
      proposedBy: params.proposedBy,
      slashAmountStroops: params.slashAmountStroops,
      fraudReason: params.fraudReason,
    });

    return { ...proposal };
  }

  // ── Stage 2: Approve ─────────────────────────────────────────────────────

  /**
   * Co-sign a pending proposal.
   *
   * The approver must be different from the proposer (dual-control).
   * Throws `SlashSelfApprovalError` if the same identity tries to approve.
   * Throws `SlashAlreadyApprovedError` if the proposal already has approval.
   */
  async approveSlash(proposalId: string, approvedBy: string): Promise<SlashProposal> {
    const proposal = this._requireProposal(proposalId);

    if (proposal.status === "executed") {
      throw new SlashAlreadyExecutedError(proposalId);
    }

    if (proposal.status === "approved") {
      throw new SlashAlreadyApprovedError(proposalId);
    }

    if (proposal.proposedBy === approvedBy) {
      throw new SlashSelfApprovalError(approvedBy);
    }

    proposal.approvedBy = approvedBy;
    proposal.approvedAt = this.nowFn();
    proposal.status = "approved";

    await this.auditSink.log("escrow.slash.approved", {
      proposalId,
      approvedBy,
      bookingId: proposal.bookingId,
    });

    return { ...proposal };
  }

  // ── Stage 3: Execute ─────────────────────────────────────────────────────

  /**
   * Execute a fully-approved slash: sweep the forfeited stake to the
   * insurance pool.
   *
   * Throws `SlashNotApprovedError` if dual-control approval has not been
   * reached.  Throws `SlashAlreadyExecutedError` on duplicate calls.
   */
  async executeSlash(proposalId: string, executedBy: string): Promise<SlashResult> {
    const proposal = this._requireProposal(proposalId);

    if (proposal.status === "executed") {
      throw new SlashAlreadyExecutedError(proposalId);
    }

    if (!this._requiresTwoAdminApproval(proposal)) {
      throw new SlashNotApprovedError(proposalId);
    }

    // Derive a deterministic-looking sweep tx hash (in production this
    // would be the real Stellar transaction hash from the on-chain sweep).
    const sweepTxHash = crypto
      .createHash("sha256")
      .update(`slash:${proposalId}:${proposal.bookingId}`, "utf8")
      .digest("hex");

    proposal.sweepTxHash = sweepTxHash;
    proposal.executedAt = this.nowFn();
    proposal.status = "executed";

    await this.auditSink.log("escrow.slash.executed", {
      proposalId,
      bookingId: proposal.bookingId,
      supplierAddress: proposal.supplierAddress,
      slashAmountStroops: proposal.slashAmountStroops,
      insurancePoolAddress: proposal.insurancePoolAddress,
      sweepTxHash,
      executedBy,
    });

    return {
      proposalId,
      sweepTxHash,
      slashAmountStroops: proposal.slashAmountStroops,
      insurancePoolAddress: proposal.insurancePoolAddress,
    };
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  getProposal(proposalId: string): SlashProposal | undefined {
    const p = this.proposals.get(proposalId);
    return p ? { ...p } : undefined;
  }

  listProposals(): SlashProposal[] {
    return Array.from(this.proposals.values()).map((p) => ({ ...p }));
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private _requireProposal(proposalId: string): SlashProposal {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new SlashProposalNotFoundError(proposalId);
    return proposal;
  }

  private _requiresTwoAdminApproval(proposal: SlashProposal): boolean {
    return (
      proposal.status === "approved" &&
      !!proposal.approvedBy &&
      proposal.approvedBy !== proposal.proposedBy
    );
  }
}
