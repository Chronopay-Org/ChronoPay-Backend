/**
 * cancellationReversal.ts
 *
 * Type definitions for the hash-chained cancellation reversal ledger
 * introduced for issue #489 (#/#-prorated-cancellation-ledger-reversal).
 *
 * ## Background
 *
 * A prorated cancellation may release only a *portion* of the originally
 * captured escrow. The original full capture amount is reflected in
 * `refund_entries` (migration 011) — the reversal ledger captures
 * the *split* between what was actually returned to the customer and
 * what was retained against a pre-agreed cancellation fee. Reconciliation
 * is therefore a NET computation:
 *
 *   netRefundNet(paymentId) = sum(refund_entries.amount)
 *                           + sum(reversal_entries.amountCents)
 *
 * where `reversal_entries.amountCents` is sign-aware:
 *   - negative → partial reversal (we returned less than the full refund)
 *   - positive → correction (we returned more after the fact, e.g. fee waiver)
 *
 * The reversible invariant enforced in `CancellationReversalLedger`
 * is: for any (bookingIntentId, currency) tuple, the SUM of
 * reversal `amountCents` MUST equal `-(computedRefundBreakdown.netRefund)`,
 * i.e. the ledger NET equals the net refund the prorated policy prescribes.
 *
 * Currency consistency: every reversal entry bound to a paymentId MUST use
 * the same currency as the originating `CheckoutSession.payment.currency`.
 * A mismatch is rejected on insert.
 */

import type { Currency } from "./checkout.js";

/** Reason codes stored on `ReversalEntry.reason`. */
export type CancellationReversalReason =
  | "prorated_cancellation"
  | "fee_waiver_correction"
  | "escrow_already_released"
  | "tenant_paused_reversal"
  | "manual_admin_adjustment";

/** Status of the escrow interaction at the time the entry was created. */
export type ReversalEscrowState =
  /** Escrow was released back to the customer (full or partial). */
  | "released"
  /** No escrow was ever held, or escrow was already released externally. */
  | "already_released"
  /** Escrow not part of this paymentId's flow. */
  | "not_applicable";

/** In-memory and persisted shape of a reversal entry. */
export interface CancellationReversalEntry {
  /** UUID. */
  id: string;
  /** Booking intent the reversal is bound to (required for the invariant). */
  bookingIntentId: string;
  /** Checkout session / paymentId this reversal reconciles against. */
  paymentId: string;
  /** Optional linkage to an existing `refund_entries.id`. */
  originalRefundId?: string;
  /**
   * Sign-aware amount in the smallest currency unit.
   * Negative => we returned less than the original (partial reversal).
   * Negative sum across the booking equals netRefund from the policy.
   */
  amountCents: number;
  /** Currency; must equal the paymentId's currency. */
  currency: Currency;
  /** Whether (any portion of) escrow was actually released for this entry. */
  escrowReleased: boolean;
  /** Amount actually released from escrow back to the customer (>=0). */
  escrowReleasedAmountCents: number;
  /** Hash of the escrow chain transaction if `escrowReleased = true`. */
  escrowReleaseTxId?: string;
  /** Stable reason code OR a free-form rationale. */
  reason: CancellationReversalReason | string;
  /** Idempotency key; UNIQUE in the persistence layer. */
  idempotencyKey: string;
  /** Policy version that authorised the reversal (grandfathered). */
  policyVersionId: string;
  /** Actor performing the reversal (userId). */
  actor: string;
  /** Optional free-form metadata (NOT included in the hash for extensibility). */
  metadata?: Record<string, unknown>;
  /** SHA-256 chain hash of this entry. */
  entryHash: string;
  /** `entry_hash` of the previous entry, or "" for the genesis row. */
  prevHash: string;
  /** Creation timestamp. */
  createdAt: Date;
}

export interface InsertCancellationReversalInput {
  bookingIntentId: string;
  paymentId: string;
  originalRefundId?: string;
  amountCents: number;
  currency: Currency;
  escrowReleased: boolean;
  escrowReleasedAmountCents: number;
  escrowReleaseTxId?: string;
  reason: CancellationReversalReason | string;
  idempotencyKey: string;
  policyVersionId: string;
  actor: string;
  metadata?: Record<string, unknown>;
}

/** Result of a `verifyChain()` walk over the reversal ledger. */
export interface ReversalVerificationResult {
  valid: boolean;
  entriesChecked: number;
  firstBrokenIndex?: number;
  error?: string;
}

/**
 * Invariant check result for a (bookingIntentId, currency) tuple.
 *
 * `valid` is true iff the sum of all reversal `amountCents` for the
 * tuple equals `-netRefund` from the prorated policy that authorised
 * them. The signer convention is documented on `CancellationReversalEntry`.
 */
export interface InvariantCheckResult {
  valid: boolean;
  bookingIntentId: string;
  currency: Currency;
  sumReversalCents: number;
  expectedNegationOfNetRefund: number;
  reason?: string;
}

/** Cross-payment trace returned by the GET /refunds/:paymentId/trace endpoint. */
export interface PaymentReversalTrace {
  paymentId: string;
  paymentCurrency: Currency;
  /**
   * Original refund entries from `refund_entries` table (unchanged).
   */
  refunds: ReadonlyArray<{
    id: string;
    amountCents: number;
    reason?: string;
    status: string;
    createdAt: number;
  }>;
  /** Reversal entries bound to this paymentId. */
  reversals: ReadonlyArray<CancellationReversalEntry>;
  /**
   * `sum(refunds.amount) + sum(reversal_entries.amountCents)` —
   * the NET paid out across original + reversal entries. Sign: positive
   * amounts are the customer-visible net refund.
   */
  netAcrossOriginalAndReversalCents: number;
  /**
   * Per-booking invariant status. Empty array means the trace is clean
   * (no reversals recorded, or all reversal sums reconcile to their
   * grand-fathered policies).
   */
  invariantStatus: InvariantCheckResult[];
  /** True iff every inv-ariant in `invariantStatus` is valid AND the chain is intact. */
  invariantValid: boolean;
}
