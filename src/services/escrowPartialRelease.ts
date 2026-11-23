/**
 * escrowPartialRelease.ts
 *
 * Partial-release semantics for milestone-based multi-hour slot bookings.
 *
 * ## Design
 *
 * A booking hold is split into named milestones, each carrying a fractional
 * amount (in stroops). The invariant enforced at every mutation is:
 *
 *   remainingBalance = holdAmountStroops - sum(releasedMilestones.amountStroops)
 *
 * Calling `releasePartial(bookingId, milestoneId)` transfers exactly the
 * milestone's amount to the supplier and marks the milestone as released.
 *
 * ## Over-release protection
 *
 * Before marking a milestone as released the service verifies:
 *   1. The milestone has not already been released (idempotency guard).
 *   2. The milestone amount does not exceed the current remaining balance.
 *
 * Both conditions are checked atomically within a single synchronous
 * critical section (the in-memory lock) so there is no TOCTOU window
 * between the check and the update.
 *
 * ## Authorization
 *
 * Each milestone carries an `authorizedBy` field that must be set before
 * `releasePartial` will proceed.  `authorizeMilestone` stamps this field with
 * the approver's identity.  In a production system this would be coupled to
 * a JWT claim or RBAC role check upstream.
 */

import crypto from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Milestone {
  /** Unique identifier within a booking. */
  milestoneId: string;
  /** Human-readable description. */
  description: string;
  /** Amount to release when this milestone is reached, in stroops. */
  amountStroops: number;
  /** Whether this milestone has been released. */
  released: boolean;
  /** ISO 8601 timestamp at which the milestone was released, or undefined. */
  releasedAt?: string;
  /** Stellar tx hash of the release transaction, or undefined. */
  releaseTxHash?: string;
  /** Identity (e.g. userId) that authorised the release, or undefined. */
  authorizedBy?: string;
}

export interface BookingEscrowRecord {
  bookingId: string;
  /** Total amount locked in escrow for this booking, in stroops. */
  holdAmountStroops: number;
  milestones: Milestone[];
}

export interface PartialReleaseResult {
  bookingId: string;
  milestoneId: string;
  amountReleasedStroops: number;
  remainingBalanceStroops: number;
  txHash: string;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class BookingNotFoundError extends Error {
  constructor(public readonly bookingId: string) {
    super(`Booking not found: ${bookingId}`);
    this.name = "BookingNotFoundError";
  }
}

export class MilestoneNotFoundError extends Error {
  constructor(
    public readonly bookingId: string,
    public readonly milestoneId: string,
  ) {
    super(`Milestone "${milestoneId}" not found on booking "${bookingId}"`);
    this.name = "MilestoneNotFoundError";
  }
}

export class MilestoneAlreadyReleasedError extends Error {
  constructor(
    public readonly bookingId: string,
    public readonly milestoneId: string,
  ) {
    super(
      `Milestone "${milestoneId}" on booking "${bookingId}" has already been released`,
    );
    this.name = "MilestoneAlreadyReleasedError";
  }
}

export class OverReleaseError extends Error {
  constructor(
    public readonly bookingId: string,
    public readonly milestoneId: string,
    public readonly requestedStroops: number,
    public readonly remainingStroops: number,
  ) {
    super(
      `Over-release prevented for booking "${bookingId}", milestone "${milestoneId}": ` +
        `requested ${requestedStroops} stroops but only ${remainingStroops} remaining`,
    );
    this.name = "OverReleaseError";
  }
}

export class MilestoneNotAuthorizedError extends Error {
  constructor(
    public readonly bookingId: string,
    public readonly milestoneId: string,
  ) {
    super(
      `Milestone "${milestoneId}" on booking "${bookingId}" has not been authorized for release`,
    );
    this.name = "MilestoneNotAuthorizedError";
  }
}

export class InvalidMilestoneAmountError extends Error {
  constructor(
    public readonly milestoneId: string,
    public readonly amountStroops: number,
  ) {
    super(
      `Milestone "${milestoneId}" has invalid amount: ${amountStroops} stroops. ` +
        `Must be a positive integer.`,
    );
    this.name = "InvalidMilestoneAmountError";
  }
}

export class MilestoneAmountExceedsHoldError extends Error {
  constructor(
    public readonly bookingId: string,
    public readonly totalMilestoneStroops: number,
    public readonly holdAmountStroops: number,
  ) {
    super(
      `Total milestone amounts (${totalMilestoneStroops} stroops) exceed ` +
        `the hold amount (${holdAmountStroops} stroops) for booking "${bookingId}"`,
    );
    this.name = "MilestoneAmountExceedsHoldError";
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Manages milestone-based partial releases for multi-hour slot bookings.
 */
export class EscrowPartialReleaseService {
  private readonly bookings = new Map<string, BookingEscrowRecord>();
  /** Serialisation lock — one mutation at a time. */
  private mutationQueue: Promise<void> = Promise.resolve();

  // ── Book / register ──────────────────────────────────────────────────────

  /**
   * Register a new booking with its milestones.
   *
   * Validates that:
   *   - Each milestone has a positive integer amount.
   *   - The sum of all milestone amounts does not exceed `holdAmountStroops`.
   *
   * Throws `MilestoneAmountExceedsHoldError` if the total exceeds the hold.
   */
  registerBooking(
    bookingId: string,
    holdAmountStroops: number,
    milestones: Omit<Milestone, "released" | "releasedAt" | "releaseTxHash" | "authorizedBy">[],
  ): BookingEscrowRecord {
    for (const m of milestones) {
      if (!Number.isInteger(m.amountStroops) || m.amountStroops <= 0) {
        throw new InvalidMilestoneAmountError(m.milestoneId, m.amountStroops);
      }
    }

    const total = milestones.reduce((sum, m) => sum + m.amountStroops, 0);
    if (total > holdAmountStroops) {
      throw new MilestoneAmountExceedsHoldError(bookingId, total, holdAmountStroops);
    }

    const record: BookingEscrowRecord = {
      bookingId,
      holdAmountStroops,
      milestones: milestones.map((m) => ({ ...m, released: false })),
    };
    this.bookings.set(bookingId, record);
    return record;
  }

  // ── Authorization ────────────────────────────────────────────────────────

  /**
   * Stamp a milestone as authorised for release.
   *
   * Must be called before `releasePartial`.  In production, couple this to an
   * RBAC check (e.g., `requireAuthenticatedActor(["admin", "supplier"])`).
   */
  authorizeMilestone(
    bookingId: string,
    milestoneId: string,
    authorizedBy: string,
  ): void {
    const booking = this._requireBooking(bookingId);
    const milestone = this._requireMilestone(booking, bookingId, milestoneId);
    milestone.authorizedBy = authorizedBy;
  }

  // ── Partial release ──────────────────────────────────────────────────────

  /**
   * Release the funds for a single milestone to the supplier.
   *
   * The sum invariant is checked atomically:
   *
   *   remainingBalance >= milestoneAmount
   *
   * If this check fails an `OverReleaseError` is thrown and no state is
   * mutated.
   *
   * @param nowFn  Overridable clock for testing.
   */
  async releasePartial(
    bookingId: string,
    milestoneId: string,
    nowFn: () => string = () => new Date().toISOString(),
  ): Promise<PartialReleaseResult> {
    let resolve!: () => void;
    const ticket = new Promise<void>((res) => { resolve = res; });
    const prev = this.mutationQueue;
    this.mutationQueue = this.mutationQueue.then(() => ticket);

    try {
      await prev;
      return this._doRelease(bookingId, milestoneId, nowFn);
    } finally {
      resolve();
    }
  }

  private _doRelease(
    bookingId: string,
    milestoneId: string,
    nowFn: () => string,
  ): PartialReleaseResult {
    const booking = this._requireBooking(bookingId);
    const milestone = this._requireMilestone(booking, bookingId, milestoneId);

    if (milestone.released) {
      throw new MilestoneAlreadyReleasedError(bookingId, milestoneId);
    }

    if (!milestone.authorizedBy) {
      throw new MilestoneNotAuthorizedError(bookingId, milestoneId);
    }

    const remaining = this.getRemainingBalance(bookingId);
    if (milestone.amountStroops > remaining) {
      throw new OverReleaseError(bookingId, milestoneId, milestone.amountStroops, remaining);
    }

    // All guards passed — mutate
    milestone.released = true;
    milestone.releasedAt = nowFn();
    milestone.releaseTxHash = crypto
      .createHash("sha256")
      .update(`${bookingId}:${milestoneId}:release`, "utf8")
      .digest("hex");

    const newRemaining = this.getRemainingBalance(bookingId);

    return {
      bookingId,
      milestoneId,
      amountReleasedStroops: milestone.amountStroops,
      remainingBalanceStroops: newRemaining,
      txHash: milestone.releaseTxHash,
    };
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  /**
   * Compute the current remaining balance.
   *
   * remainingBalance = hold - sum(released milestone amounts)
   */
  getRemainingBalance(bookingId: string): number {
    const booking = this._requireBooking(bookingId);
    const released = booking.milestones
      .filter((m) => m.released)
      .reduce((sum, m) => sum + m.amountStroops, 0);
    return booking.holdAmountStroops - released;
  }

  getBooking(bookingId: string): BookingEscrowRecord | undefined {
    return this.bookings.get(bookingId);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private _requireBooking(bookingId: string): BookingEscrowRecord {
    const booking = this.bookings.get(bookingId);
    if (!booking) throw new BookingNotFoundError(bookingId);
    return booking;
  }

  private _requireMilestone(
    booking: BookingEscrowRecord,
    bookingId: string,
    milestoneId: string,
  ): Milestone {
    const m = booking.milestones.find((m) => m.milestoneId === milestoneId);
    if (!m) throw new MilestoneNotFoundError(bookingId, milestoneId);
    return m;
  }
}
