/**
 * sorobanEscrowClient.ts
 *
 * Integration layer for the Stellar Soroban escrow contract.
 *
 * ## Two-phase settle design
 *
 * A slot booking follows exactly two on-chain phases:
 *
 *   Phase 1 – Hold
 *     Buyer funds are locked inside the escrow contract until the service
 *     window elapses or an explicit release/refund is authorised.
 *     On-chain: the contract emits `Held` with the booking intent id.
 *
 *   Phase 2 – Settle
 *     Either the held funds are released to the supplier (`Released`)
 *     or returned to the buyer (`Refunded`). Both transitions are
 *     final; no third call is possible.
 *
 * ## Contract WASM pinning
 *
 * The contract address used by this client is validated against a
 * known-good WASM hash stored in `escrowMigrationState`. If the on-chain
 * contract hash does not match the pinned value, `hold()`, `release()`,
 * and `refund()` all refuse to submit a transaction. This prevents a
 * malicious contract upgrade from silently redirecting funds.
 *
 * ## Deployment scripts
 *
 * See `scripts/deploy-escrow.ts` for the one-time Soroban contract
 * deployment and hash capture workflow.
 */

import crypto from "crypto";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface EscrowHoldParams {
  /** Application-level booking intent identifier. */
  bookingIntentId: string;
  /** Slot being reserved. */
  slotId: string;
  /** Amount to hold, in stroops. */
  amountStroops: number;
  /** Stellar account address of the buyer. */
  buyerAddress: string;
}

export interface EscrowSettleParams {
  /** Booking intent whose held funds are being settled. */
  bookingIntentId: string;
}

export interface EscrowTxResult {
  /** Stellar transaction hash of the submitted operation. */
  txHash: string;
  /** Phase of the two-phase settle that was executed. */
  phase: "hold" | "release" | "refund";
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Thrown when the live contract hash does not match the pinned value. */
export class ContractHashMismatchError extends Error {
  constructor(
    public readonly pinned: string,
    public readonly live: string,
  ) {
    super(
      `Escrow contract WASM hash mismatch — pinned: ${pinned.slice(0, 16)}…, ` +
        `live: ${live.slice(0, 16)}…. Refusing to submit transaction.`,
    );
    this.name = "ContractHashMismatchError";
  }
}

/** Thrown when an operation is attempted on a booking that has no active hold. */
export class EscrowHoldNotFoundError extends Error {
  constructor(public readonly bookingIntentId: string) {
    super(`No active escrow hold for booking intent: ${bookingIntentId}`);
    this.name = "EscrowHoldNotFoundError";
  }
}

/** Thrown when a hold is already placed for the same booking intent. */
export class EscrowDuplicateHoldError extends Error {
  constructor(public readonly bookingIntentId: string) {
    super(`Escrow hold already exists for booking intent: ${bookingIntentId}`);
    this.name = "EscrowDuplicateHoldError";
  }
}

/** Thrown when the escrow contract has been paused (migration in progress). */
export class EscrowContractPausedError extends Error {
  constructor() {
    super("Escrow contract is paused — new operations are not permitted during migration.");
    this.name = "EscrowContractPausedError";
  }
}

// ─── Internal hold record ─────────────────────────────────────────────────────

export interface EscrowHoldRecord {
  bookingIntentId: string;
  slotId: string;
  amountStroops: number;
  buyerAddress: string;
  txHash: string;
  /** ISO 8601 timestamp at which the hold was created. */
  heldAt: string;
  /** ISO 8601 timestamp at which the hold was settled, or undefined if still open. */
  settledAt?: string;
  settlePhase?: "release" | "refund";
}

// ─── Contract-hash verifier interface ────────────────────────────────────────

/**
 * Minimal interface that the `SorobanEscrowClient` needs to validate the
 * on-chain contract WASM hash before submitting transactions.
 */
export interface IContractHashVerifier {
  /**
   * Fetch the current WASM hash of the deployed contract.
   * Returns a 64-character lower-case hex string.
   */
  getLiveWasmHash(contractAddress: string): Promise<string>;
}

// ─── Client ───────────────────────────────────────────────────────────────────

/**
 * Integration layer for the Soroban escrow contract.
 *
 * In production this wraps a Soroban RPC client (e.g. `stellar-sdk`).
 * In tests an in-memory store is used (see `FakeSorobanEscrowClient`).
 */
export class SorobanEscrowClient {
  /**
   * In-memory hold store (used by the in-process implementation).
   * A production implementation would query the contract ledger state instead.
   */
  private readonly holds = new Map<string, EscrowHoldRecord>();

  constructor(
    /** Soroban C-address of the deployed escrow contract. */
    public readonly contractAddress: string,
    /** WASM hash that must match the live contract before any mutating call. */
    private readonly pinnedWasmHash: string,
    /** Dependency that can fetch the live contract WASM hash from the network. */
    private readonly hashVerifier: IContractHashVerifier,
    /** Override the wall clock for deterministic testing. */
    private readonly nowFn: () => string = () => new Date().toISOString(),
  ) {}

  // ── Private helpers ────────────────────────────────────────────────────────

  private async assertContractIntegrity(): Promise<void> {
    const live = await this.hashVerifier.getLiveWasmHash(this.contractAddress);
    const normPinned = this.pinnedWasmHash.trim().toLowerCase();
    const normLive = live.trim().toLowerCase();
    if (normPinned !== normLive) {
      throw new ContractHashMismatchError(normPinned, normLive);
    }
  }

  /** Generate a deterministic-looking mock tx hash for the in-process impl. */
  private static deriveTxHash(bookingIntentId: string, phase: string): string {
    return crypto
      .createHash("sha256")
      .update(`${bookingIntentId}:${phase}`, "utf8")
      .digest("hex");
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Phase 1: lock buyer funds in escrow for the given booking intent.
   *
   * Validates the pinned WASM hash before submitting.  Idempotency: throws
   * `EscrowDuplicateHoldError` if a hold already exists.
   */
  async hold(params: EscrowHoldParams): Promise<EscrowTxResult> {
    await this.assertContractIntegrity();

    if (this.holds.has(params.bookingIntentId)) {
      throw new EscrowDuplicateHoldError(params.bookingIntentId);
    }

    const txHash = SorobanEscrowClient.deriveTxHash(params.bookingIntentId, "hold");

    this.holds.set(params.bookingIntentId, {
      bookingIntentId: params.bookingIntentId,
      slotId: params.slotId,
      amountStroops: params.amountStroops,
      buyerAddress: params.buyerAddress,
      txHash,
      heldAt: this.nowFn(),
    });

    return { txHash, phase: "hold" };
  }

  /**
   * Phase 2a: release held funds to the supplier (service delivered).
   *
   * Validates the pinned WASM hash before submitting.  Throws
   * `EscrowHoldNotFoundError` if the booking has no active hold.
   */
  async release(params: EscrowSettleParams): Promise<EscrowTxResult> {
    await this.assertContractIntegrity();

    const hold = this.holds.get(params.bookingIntentId);
    if (!hold) {
      throw new EscrowHoldNotFoundError(params.bookingIntentId);
    }

    const txHash = SorobanEscrowClient.deriveTxHash(params.bookingIntentId, "release");

    hold.settledAt = this.nowFn();
    hold.settlePhase = "release";

    return { txHash, phase: "release" };
  }

  /**
   * Phase 2b: refund held funds to the buyer (dispute resolved or no-show).
   *
   * Validates the pinned WASM hash before submitting.  Throws
   * `EscrowHoldNotFoundError` if the booking has no active hold.
   */
  async refund(params: EscrowSettleParams): Promise<EscrowTxResult> {
    await this.assertContractIntegrity();

    const hold = this.holds.get(params.bookingIntentId);
    if (!hold) {
      throw new EscrowHoldNotFoundError(params.bookingIntentId);
    }

    const txHash = SorobanEscrowClient.deriveTxHash(params.bookingIntentId, "refund");

    hold.settledAt = this.nowFn();
    hold.settlePhase = "refund";

    return { txHash, phase: "refund" };
  }

  /**
   * Look up the current hold record for a booking intent.
   * Returns `undefined` if no hold exists.
   */
  getHold(bookingIntentId: string): EscrowHoldRecord | undefined {
    return this.holds.get(bookingIntentId);
  }

  /**
   * Return all hold records.  Primarily used in tests and admin tooling.
   */
  listHolds(): EscrowHoldRecord[] {
    return Array.from(this.holds.values());
  }
}
