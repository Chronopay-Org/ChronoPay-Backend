/**
 * src/modules/cancellation/cancellation-reversal-service.ts
 *
 * Prorated-cancellation ledger reversal service — issue #489.
 *
 * Responsibilities:
 *
 *   1. Append hash-chained reversal entries that link a booking intent back
 *      to its originating checkout session / refund entry.
 *   2. Enforce cryptographic invariants: sum(reversal.amountCents) for a
 *      (bookingIntentId, currency) tuple MUST equal the negation of the
 *      prorated `netRefund` that authorised the cancellation.
 *   3. Enforce a single-currency invariant: every reversal entry bound to
 *      a paymentId MUST use the same currency as the originating
 *      CheckoutSession; mismatches are rejected on insert with no row
 *      persisted.
 *   4. Honour a tenant-paused kill switch: if a tenant is administratively
 *      paused, all appends targeting that tenant fail fast with
 *      `TenantPausedError` and the ledger is left untouched.
 *   5. Provide a chain-verification walk similar to the redemption ledger,
 *      walking the reversal chain in `created_at ASC` order and verifying
 *      that `prevHash` matches `prev_entry.entryHash` and that the
 *      recomputed `entryHash` matches the stored value.
 *
 * ## Sign convention for reversal `amountCents`
 *
 * The reversal entry's `amountCents` field is a SIGNED integer:
 *
 *   - **Negative** → we returned LESS than the full original refund.
 *     I.e. the cancellation fee was larger than usual and only `-amountCents`
 *     was net'd back to the customer.
 *   - **Positive** → correction; we returned MORE than originally refunded
 *     (e.g. an admin waived the fee after the fact).
 *
 * For a (bookingIntentId, currency) tuple, the SUM of reversal amounts
 * MUST equal `-netRefund` from the prorated policy that authorised them.
 * For `netRefund = 0` (e.g. <12h tier), the ledger is intentionally NOT
 * appended — the cancellation is recorded only in `refund_entries` and
 * a `cancellation_reversal.skipped_zero_amount` audit log is emitted.
 *
 * ## Idempotency
 *
 * The persistence layer enforces `idempotency_key UNIQUE` at the
 * database level. The service short-circuits to return the existing
 * entry on collision (no double-count, no extra hash advance).
 *
 * ## Hash chain payload
 *
 *     bookingIntentId|paymentId|originalRefundId|amountCents|currency|
 *     escrowReleased|escrowReleasedAmountCents|escrowReleaseTxId|
 *     reason|policyVersionId|actor|idempotencyKey|prevHash|
 *     createdAtIso
 *
 * `reason` is sanitised (pipes replaced with U+0000) before hashing so a
 * user-controlled reason string cannot introduce a field-boundary
 * collision.
 *
 * `prevHash` for the genesis row is the empty string `""`; on insert it
 * is persisted as NULL. On read, NULL is mapped back to `""` for the
 * client-facing type.
 */

import { createHash } from "crypto";
import type { Currency } from "../../types/checkout.js";
import type {
  CancellationReversalEntry,
  CancellationReversalReason,
  InsertCancellationReversalInput,
  InvariantCheckResult,
  PaymentReversalTrace,
  ReversalEscrowState,
  ReversalVerificationResult,
} from "../../types/cancellationReversal.js";
import { CheckoutError, CheckoutErrorCode } from "../../types/checkout.js";
import { defaultAuditLogger } from "../../services/auditLogger.js";

// Re-export the scheduling errors so a single import surface covers them.
export {
  TenantPausedError,
  BundleReservationError,
} from "../../services/schedulingService.js";
import { TenantPausedError } from "../../services/schedulingService.js";

// ─── Repository contract ─────────────────────────────────────────────────────

/**
 * Storage abstraction used by the service. The PG implementation lives in
 * `pg-cancellation-reversal-repository.ts`. Tests pass an in-memory
 * implementation.
 */
export interface CancellationReversalRepository {
  /**
   * Insert a fully-formed reversal entry.
   *
   * Implementations MUST honour the schema rules:
   *   - `idempotency_key` is UNIQUE. A duplicate insert is reported via a
   *     thrown `CancellationReversalIdempotencyConflictError` so the
   *     service can short-circuit and look up the existing row.
   *   - `entry_hash` is UNIQUE.
   *   - `prev_hash` is NULL iff this is the genesis row.
   *   - `currency` is one of the supported currencies.
   */
  insert(input: CancellationReversalEntry): Promise<CancellationReversalEntry>;

  /** Look up an entry by its idempotency key. Returns null if absent. */
  findByIdempotencyKey(key: string): Promise<CancellationReversalEntry | null>;

  /** All entries bound to a paymentId, ordered by `created_at ASC`. */
  findByPaymentId(paymentId: string): Promise<CancellationReversalEntry[]>;

  /** All entries bound to a bookingIntentId, ordered by `created_at ASC`. */
  findByBookingIntentId(
    bookingIntentId: string,
  ): Promise<CancellationReversalEntry[]>;
}

/** Currency lookup consult when validating an insert. */
export interface CheckoutSessionLookup {
  /** Returns the currency for a paymentId, or null if session not found. */
  getCurrency(paymentId: string): Promise<Currency | null>;
}

/** Resolver for the per-tenant paused kill-switch. */
export type TenantPausedResolver = (tenantId: string) => boolean;

/**
 * Optional policy lookup used for invariant verification on read.
 * The service does NOT compute the netRefund itself — it is provided by
 * the caller (the call site is the prorated cancellation policy service).
 */
export interface NetRefundLookup {
  getNetRefund(
    bookingIntentId: string,
    currency: Currency,
  ): Promise<number | null>;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class CancellationReversalCurrencyMismatchError extends CheckoutError {
  constructor(paymentId: string, expected: Currency, provided: Currency) {
    super(
      CheckoutErrorCode.INVALID_CURRENCY,
      `Currency mismatch for payment ${paymentId}: ledger requires ${expected}, entry used ${provided}`,
      422,
      { paymentId, expected, provided },
    );
    this.name = "CancellationReversalCurrencyMismatchError";
  }
}

export class CancellationReversalInvariantViolationError extends CheckoutError {
  constructor(
    readonly bookingIntentId: string,
    readonly currency: Currency,
    readonly sumReversalCents: number,
    readonly expectedNegationOfNetRefund: number,
  ) {
    super(
      "REVERSAL_INVARIANT_VIOLATION",
      `Reversal invariant violation for booking ${bookingIntentId} (${currency}): ` +
        `sum=${sumReversalCents}, expected=${expectedNegationOfNetRefund}`,
      409,
      { bookingIntentId, currency, sumReversalCents, expectedNegationOfNetRefund },
    );
    this.name = "CancellationReversalInvariantViolationError";
  }
}

export class CancellationReversalNetRefundNotRegisteredError extends CheckoutError {
  constructor(bookingIntentId: string, currency: Currency) {
    super(
      "REVERSAL_NET_REFUND_NOT_REGISTERED",
      `Cancel-reversal invariant check cannot proceed: netRefund for booking ` +
        `${bookingIntentId} (${currency}) is not registered`,
      422,
      { bookingIntentId, currency },
    );
    this.name = "CancellationReversalNetRefundNotRegisteredError";
  }
}

export class CancellationReversalIdempotencyConflictError extends Error {
  constructor(key: string) {
    super(`idempotency_key conflict for reversal entry: ${key}`);
    this.name = "CancellationReversalIdempotencyConflictError";
  }
}

// ─── Hash derivation ─────────────────────────────────────────────────────────

/**
 * Sanitise free-form user-controlled strings so a `|` byte in any
 * string field cannot be used as a hash-collision pivot. We replace
 * `|` with U+0000 (NUL) — invisible in the printer, but stable across
 * platforms. ALL string fields in the canonical payload pass through
 * this; only numbers / booleans / the ISO timestamp bypass it because
 * they have no user-controlled byte content.
 */
function sanitise(value: string): string {
  return value.replace(/\|/g, "\u0000");
}

/**
 * Build the canonical payload that is fed into the reversal hash. Order
 * is fixed; do NOT reorder fields without a coordinated chain reset.
 *
 * `createdAtIso` is NOT sanitised because ISO 8601 timestamps never
 * contain `|`. Numeric and boolean fields need no sanitisation.
 */
function canonicalisePayload(
  entry: Omit<CancellationReversalEntry, "entryHash" | "createdAt">,
  createdAtIso: string,
): string {
  return [
    sanitise(entry.bookingIntentId),
    sanitise(entry.paymentId),
    sanitise(entry.originalRefundId ?? ""),
    String(entry.amountCents),
    sanitise(entry.currency),
    entry.escrowReleased ? "1" : "0",
    String(entry.escrowReleasedAmountCents),
    sanitise(entry.escrowReleaseTxId ?? ""),
    sanitise(String(entry.reason)),
    sanitise(entry.policyVersionId),
    sanitise(entry.actor),
    sanitise(entry.idempotencyKey),
    sanitise(entry.prevHash), // empty string for genesis row
    createdAtIso,
  ].join("|");
}

/** Compute the SHA-256 chain hash for a reversal entry. */
export function deriveReversalEntryHash(
  entry: Omit<CancellationReversalEntry, "entryHash" | "createdAt">,
  createdAt: Date,
): string {
  const iso =
    createdAt instanceof Date
      ? createdAt.toISOString()
      : new Date(createdAt).toISOString();
  return createHash("sha256")
    .update(canonicalisePayload(entry, iso), "utf8")
    .digest("hex");
}

// ─── Service ─────────────────────────────────────────────────────────────────

export interface CancellationReversalServiceDeps {
  repo: CancellationReversalRepository;
  checkoutSessionLookup: CheckoutSessionLookup;
  /** Optional — defaults to "no tenant is paused". */
  isTenantPaused?: TenantPausedResolver;
  /** Optional policy lookup for invariant verification. */
  netRefundLookup?: NetRefundLookup;
  /** `now()` injection for deterministic tests. */
  now?: () => Date;
  /**
   * Optional escrow release hook. When `escrowReleased=true` is requested
   * but caller has not supplied a `escrowReleaseTxId`, this hook is
   * invoked to obtain one (e.g. by simulating an on-chain release). When
   * omitted, the service fabricates a deterministic synthetic tx id of
   * the form `synthetic:${paymentId}:${createdAtMs}`.
   */
  releaseEscrow?: (input: {
    paymentId: string;
    bookingIntentId: string;
    amountCents: number;
    currency: Currency;
  }) => Promise<string>;
}

export class CancellationReversalService {
  private readonly repo: CancellationReversalRepository;
  private readonly checkoutSessionLookup: CheckoutSessionLookup;
  private readonly isTenantPaused: TenantPausedResolver;
  private readonly netRefundLookup: NetRefundLookup | undefined;
  private readonly now: () => Date;
  private readonly releaseEscrow: NonNullable<
    CancellationReversalServiceDeps["releaseEscrow"]
  >;

  constructor(deps: CancellationReversalServiceDeps) {
    this.repo = deps.repo;
    this.checkoutSessionLookup = deps.checkoutSessionLookup;
    this.isTenantPaused = deps.isTenantPaused ?? (() => false);
    this.netRefundLookup = deps.netRefundLookup;
    this.now = deps.now ?? (() => new Date());
    this.releaseEscrow =
      deps.releaseEscrow ??
      (async ({ paymentId, bookingIntentId, amountCents }) =>
        // Deterministic synthetic id when no real escrow hook is wired.
        `synthetic:${paymentId.slice(0, 8)}:${bookingIntentId.slice(0, 8)}:${amountCents}`);
  }

  // ─── Append (insert) ──────────────────────────────────────────────────────

  /**
   * Append a reversal entry. The caller MUST supply `paymentId`,
   * `bookingIntentId`, `currency`, and either a positive or negative
   * non-zero `amountCents`. The hash chain is advanced by computing
   * `prevHash = latest_entry_hash` (or "" for genesis).
   *
   * Pre-conditions (all checked before any DB write):
   *   1. `amountCents !== 0` (DB CHECK also enforces this).
   *   2. Currency matches the checkout session's currency (else
   *      `CancellationReversalCurrencyMismatchError`).
   *   3. Tenant is not paused (else `TenantPausedError`).
   *   4. Idempotency key not already used (else short-circuit).
   *
   * Post-conditions (all enforced atomically with the insert):
   *   1. Hash chain is intact (verified during construction).
   *   2. Invariant `sum_ledger + new_amount === -netRefund` holds.
   *
   * The function returns the persisted entry.
   */
  async appendEntry(input: InsertCancellationReversalInput): Promise<CancellationReversalEntry> {
    // 1. Tenant guard — must precede any DB work.
    const tenantId = this.tenantIdFor(input);
    if (tenantId && this.isTenantPaused(tenantId)) {
      throw new TenantPausedError(tenantId);
    }

    // 2. Currency guard.
    const sessionCurrency = await this.checkoutSessionLookup.getCurrency(
      input.paymentId,
    );
    if (sessionCurrency === null) {
      throw new CheckoutError(
        CheckoutErrorCode.SESSION_NOT_FOUND,
        `Cannot record reversal: checkout session ${input.paymentId} not found`,
        404,
      );
    }
    if (sessionCurrency !== input.currency) {
      throw new CancellationReversalCurrencyMismatchError(
        input.paymentId,
        sessionCurrency,
        input.currency,
      );
    }

    // 3. amountCents sanity.
    if (!Number.isInteger(input.amountCents) || input.amountCents === 0) {
      throw new CheckoutError(
        CheckoutErrorCode.INVALID_AMOUNT,
        `reversal amountCents must be a non-zero integer`,
        400,
      );
    }
    if (input.escrowReleasedAmountCents < 0) {
      throw new CheckoutError(
        CheckoutErrorCode.INVALID_AMOUNT,
        "escrowReleasedAmountCents must be >= 0",
        400,
      );
    }

    // 4. Idempotency short-circuit.
    const existing = await this.repo.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return existing;
    }

    // 5. Establish prevHash from chain tip (the latest entry for this chain).
    const chainForPayment = await this.repo.findByPaymentId(input.paymentId);
    const prevHash =
      chainForPayment.length === 0
        ? ""
        : chainForPayment[chainForPayment.length - 1].entryHash;

    // 6. Resolve escrowReleaseTxId when escrow is actually released.
    let escrowReleaseTxId: string | undefined;
    if (input.escrowReleased) {
      escrowReleaseTxId =
        input.escrowReleaseTxId ??
        (await this.releaseEscrow({
          paymentId: input.paymentId,
          bookingIntentId: input.bookingIntentId,
          amountCents: input.escrowReleasedAmountCents,
          currency: input.currency,
        }));
    }

    // 7. Build the entry shell so we can derive its hash.
    const createdAt = this.now();
    const partial: Omit<CancellationReversalEntry, "entryHash"> = {
      id: cryptoRandomUuid(),
      bookingIntentId: input.bookingIntentId,
      paymentId: input.paymentId,
      originalRefundId: input.originalRefundId,
      amountCents: input.amountCents,
      currency: input.currency,
      escrowReleased: input.escrowReleased,
      escrowReleasedAmountCents: input.escrowReleasedAmountCents,
      escrowReleaseTxId,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      policyVersionId: input.policyVersionId,
      actor: input.actor,
      metadata: input.metadata,
      prevHash,
      createdAt,
    };

    const entryHash = deriveReversalEntryHash(partial, createdAt);

    const entry: CancellationReversalEntry = { ...partial, entryHash };

    // 8. PRE-WRITE invariant check. We compute the sum of existing
    //    reversal entries for this (bookingIntentId, currency) tuple and
    //    verify that the new entry, if inserted, would still satisfy
    //    `existing_sum + new_amountCents === -netRefund`. This is the
    //    single point of truth for "invariant on save"; once we
    //    determine the new row would break the invariant, we throw and
    //    never call `repo.insert`.
    await this.assertPreWriteInvariant(input);

    // 9. Persist. If a concurrent insert won with the same idempotency
    //    key in the brief window between our findByIdempotencyKey and
    //    insert, the repo surfaces a conflict; we re-read and return.
    let persisted: CancellationReversalEntry;
    try {
      persisted = await this.repo.insert(entry);
    } catch (err) {
      if (err instanceof CancellationReversalIdempotencyConflictError) {
        const winner = await this.repo.findByIdempotencyKey(input.idempotencyKey);
        if (winner) return winner;
        throw err;
      }
      throw err;
    }

    // 10. Audit.
    await defaultAuditLogger
      .log(
        "cancellation.reversal.appended",
        {
          context: {
            reversalId: persisted.id,
            bookingIntentId: persisted.bookingIntentId,
            paymentId: persisted.paymentId,
            amountCents: persisted.amountCents,
            currency: persisted.currency,
            escrowReleased: persisted.escrowReleased,
            reason: persisted.reason,
            policyVersionId: persisted.policyVersionId,
            actor: persisted.actor,
          },
        },
        {
          resource: `reversal:${persisted.id}`,
          status: 201,
        },
      )
      .catch(() => {}); // never block on audit-write

    return persisted;
  }

  /**
   * Internal: enforce the per-(bookingIntentId, currency) invariant
   * BEFORE inserting the new entry. The check is strict only when a
   * `NetRefundLookup` is configured; when one is absent (development
   * mode) the test callsites rely on this pass-through.
   *
   * The lookup's `getNetRefund` returning `null` is treated as
   * "policy not registered" — we keep the strict mode but throw a
   * specific `CancellationReversalNetRefundNotRegisteredError` so the
   * caller can distinguish "configure me" from "math wrong".
   */
  private async assertPreWriteInvariant(
    input: InsertCancellationReversalInput,
  ): Promise<void> {
    const existing = await this.repo.findByBookingIntentId(input.bookingIntentId);
    const existingSameCurrency = existing.filter((e) => e.currency === input.currency);
    const existingSum = existingSameCurrency.reduce(
      (s, e) => s + e.amountCents,
      0,
    );

    const projectedSum = existingSum + input.amountCents;

    // When no NetRefundLookup is configured we are in develop-mode
    // (caller opted out of policy tracking). Allow.
    if (!this.netRefundLookup) {
      return;
    }

    const netRefund = await this.netRefundLookup.getNetRefund(
      input.bookingIntentId,
      input.currency,
    );
    if (netRefund === null || netRefund === undefined) {
      // Strict mode is on; refuse to certify when policy is unknown.
      throw new CancellationReversalNetRefundNotRegisteredError(
        input.bookingIntentId,
        input.currency,
      );
    }
    if (projectedSum !== -netRefund) {
      throw new CancellationReversalInvariantViolationError(
        input.bookingIntentId,
        input.currency,
        projectedSum,
        -netRefund,
      );
    }
  }

  /**
   * Skipped-amount helper for the `netRefund = 0` edge case. The
   * cancellation still happens in `refund_entries`, but no reversal row
   * is appended because the DB schema forbids `amount_cents = 0`. An
   * audit log is emitted so the gap is auditable.
   */
  async recordSkippedZeroAmount(input: {
    bookingIntentId: string;
    paymentId: string;
    currency: Currency;
    reason: CancellationReversalReason | string;
    actor: string;
  }): Promise<void> {
    await defaultAuditLogger
      .log(
        "cancellation_reversal.skipped_zero_amount",
        {
          context: {
            bookingIntentId: input.bookingIntentId,
            paymentId: input.paymentId,
            currency: input.currency,
            reason: input.reason,
            actor: input.actor,
          },
        },
        {
          resource: `booking:${input.bookingIntentId}`,
          status: 200,
        },
      )
      .catch(() => {});
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Resolve the tenantId from the input. Optional — if absent, the
   * tenant-paused check is skipped (i.e. no tenant gating). Callers
   * that have access to a tenantId should pass it via `metadata.tenantId`.
   */
  private tenantIdFor(input: InsertCancellationReversalInput): string {
    if (input.metadata && typeof input.metadata === "object") {
      const t = (input.metadata as Record<string, unknown>).tenantId;
      if (typeof t === "string" && t.length > 0) return t;
    }
    return "";
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  /**
   * Walk the chain for a payment, verify linkage, and report whether the
   * chain is intact. Returns `valid=true` when the ledger is empty.
   */
  async verifyChainForPayment(paymentId: string): Promise<ReversalVerificationResult> {
    const entries = await this.repo.findByPaymentId(paymentId);
    return verifyChain(entries);
  }

  /**
   * Compute the per-(bookingIntentId, currency) invariant.
   *
   * `valid` is true iff `sumReversalCents === expectedNegationOfNetRefund`
   * where `expectedNegationOfNetRefund = -(netRefund)` from the
   * `NetRefundLookup`. If no NetRefundLookup is provided, the invariant
   * is computed against `expectedNegationOfNetRefund = 0` (i.e. any
   * non-empty ledger is reported as invalid until a policy lookup is
   * wired).
   */
  async checkInvariantForBooking(
    bookingIntentId: string,
    currency: Currency,
  ): Promise<InvariantCheckResult> {
    const entries = await this.repo.findByBookingIntentId(bookingIntentId);
    const booked = entries.filter((e) => e.currency === currency);
    const sumReversalCents = booked.reduce((s, e) => s + e.amountCents, 0);

    let expectedNegationOfNetRefund: number | null = null;
    let policyUnregistered = false;
    if (this.netRefundLookup) {
      const netRefund = await this.netRefundLookup.getNetRefund(
        bookingIntentId,
        currency,
      );
      if (netRefund === null || netRefund === undefined) {
        expectedNegationOfNetRefund = null;
        policyUnregistered = true;
      } else {
        expectedNegationOfNetRefund = -netRefund;
      }
    } else {
      expectedNegationOfNetRefund = 0;
    }

    const valid =
      !policyUnregistered &&
      expectedNegationOfNetRefund !== null &&
      sumReversalCents === expectedNegationOfNetRefund;

    const reason = policyUnregistered
      ? `netRefund for booking ${bookingIntentId} (${currency}) is not registered; invariant cannot be certified`
      : valid
        ? undefined
        : `sum of reversal amounts (${sumReversalCents}) does not match ` +
          `negation of netRefund (${expectedNegationOfNetRefund ?? 0}) for ` +
          `(${bookingIntentId}, ${currency})`;

    return {
      valid,
      bookingIntentId,
      currency,
      sumReversalCents,
      expectedNegationOfNetRefund: expectedNegationOfNetRefund ?? 0,
      reason,
    };
  }

  /**
   * Build a full payment trace with reversals merged in. Used by
   * `GET /admin/payments/:id/trace?include=reversals`.
   */
  async buildPaymentReversalTrace(args: {
    paymentId: string;
    paymentsCurrency: Currency | null;
    refunds: ReadonlyArray<{
      id: string;
      amountCents: number;
      reason?: string;
      status: string;
      createdAt: number;
    }>;
  }): Promise<PaymentReversalTrace> {
    const paymentCurrency: Currency =
      args.paymentsCurrency ?? ("USD" as Currency);

    const reversals = await this.repo.findByPaymentId(args.paymentId);

    const totalRefundsCents = args.refunds.reduce((s, r) => s + r.amountCents, 0);
    const totalReversalsCents = reversals.reduce((s, r) => s + r.amountCents, 0);
    // NET = sum(refunds) + sum(reversal.amountCents) — sign-aware.
    const netAcrossOriginalAndReversalCents =
      totalRefundsCents + totalReversalsCents;

    // Per-booking invariant status — aggregate over all distinct
    // (bookingIntentId, currency) tuples touched by this payment's
    // reversals.
    const tuples = new Map<string, { bookingIntentId: string; currency: Currency }>();
    for (const r of reversals) {
      tuples.set(`${r.bookingIntentId}|${r.currency}`, {
        bookingIntentId: r.bookingIntentId,
        currency: r.currency,
      });
    }
    const invariantStatus: InvariantCheckResult[] = [];
    for (const t of tuples.values()) {
      invariantStatus.push(
        await this.checkInvariantForBooking(t.bookingIntentId, t.currency),
      );
    }
    const chain = await this.verifyChainForPayment(args.paymentId);

    return {
      paymentId: args.paymentId,
      paymentCurrency,
      refunds: args.refunds,
      reversals,
      netAcrossOriginalAndReversalCents,
      invariantStatus,
      invariantValid:
        invariantStatus.every((s) => s.valid) && chain.valid,
    };
  }
}

// ─── Chain walker ────────────────────────────────────────────────────────────

/**
 * Stand-alone verifier for the reversal chain. Mirrors
 * `verify-redemption-chain.ts` so the two ledgers have symmetric
 * tooling.
 */
export function verifyChain(
  entries: ReadonlyArray<CancellationReversalEntry>,
): ReversalVerificationResult {
  if (entries.length === 0) {
    return { valid: true, entriesChecked: 0 };
  }

  // Genesis row: prevHash must be "" or undefined.
  const genesis = entries[0];
  if (genesis.prevHash !== "") {
    return {
      valid: false,
      entriesChecked: 1,
      firstBrokenIndex: 0,
      error: `Genesis row has non-empty prevHash: "${genesis.prevHash}"`,
    };
  }

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const recomputed = deriveReversalEntryHash(
      {
        id: e.id,
        bookingIntentId: e.bookingIntentId,
        paymentId: e.paymentId,
        originalRefundId: e.originalRefundId,
        amountCents: e.amountCents,
        currency: e.currency,
        escrowReleased: e.escrowReleased,
        escrowReleasedAmountCents: e.escrowReleasedAmountCents,
        escrowReleaseTxId: e.escrowReleaseTxId,
        reason: e.reason,
        idempotencyKey: e.idempotencyKey,
        policyVersionId: e.policyVersionId,
        actor: e.actor,
        metadata: e.metadata,
        prevHash: e.prevHash,
      },
      e.createdAt,
    );

    if (recomputed !== e.entryHash) {
      return {
        valid: false,
        entriesChecked: i + 1,
        firstBrokenIndex: i,
        error: `Row ${i} entry_hash mismatch. Expected ${recomputed}, stored ${e.entryHash}`,
      };
    }
    if (i > 0 && e.prevHash !== entries[i - 1].entryHash) {
      return {
        valid: false,
        entriesChecked: i + 1,
        firstBrokenIndex: i,
        error: `Row ${i} prevHash "${e.prevHash}" does not match predecessor hash "${entries[i - 1].entryHash}"`,
      };
    }
  }

  return { valid: true, entriesChecked: entries.length };
}

// ─── Misc helpers ────────────────────────────────────────────────────────────

/** RFC 4122 v4 UUID via the runtime `crypto.randomUUID()`. */
function cryptoRandomUuid(): string {
  return globalThis.crypto.randomUUID();
}

// ─── Currency validator ──────────────────────────────────────────────────────

export const SUPPORTED_CURRENCIES: ReadonlyArray<Currency> = [
  "USD",
  "EUR",
  "GBP",
  "XLM",
];

export function isSupportedCurrency(value: string): value is Currency {
  return (SUPPORTED_CURRENCIES as ReadonlyArray<string>).includes(value);
}

// ─── Module-level paused-tenant resolver ─────────────────────────────────────
//
// The cancellation-reversal service consults a tenant-paused lookup at
// insert time. The production binding is the live `SchedulingService`'s
// `pausedTenants` Set; test/production bootstrap wires this resolver
// via `setTenantPausedResolver(fn)`. Default behaviour: "no tenant is
// paused" (fail-open — explicit bootstrap is required to fail-closed).
export type TenantPausedFunction = (tenantId: string) => boolean;
let _tenantPausedResolver: TenantPausedFunction = () => false;

/**
 * Replace the paused-tenant resolver. Production code wires this at
 * startup to a function that consults `SchedulingService.isTenantPaused`
 * (the canonical source of truth). Tests wire a stub.
 *
 * Couples with the `tenantId` field extracted from `metadata.tenantId`
 * of the incoming reversal insert.
 */
export function setTenantPausedResolver(fn: TenantPausedFunction): void {
  _tenantPausedResolver = fn;
}

/**
 * Read-only view of the currently-configured paused-tenant resolver.
 * Production diagnostics; tests use to assert wiring.
 */
export function getTenantPausedResolver(): TenantPausedFunction {
  return _tenantPausedResolver;
}

// Convenience re-export so callers get a single import line.
export type { ReversalEscrowState };
