/**
 * src/modules/cancellation/__tests__/cancellation-reversal-service.test.ts
 *
 * Test suite for `CancellationReversalService` (issue #489).
 *
 * Coverage targets:
 *   - append happy-path + chain-walk + invariant pass
 *   - currency mismatch (rejected on insert, no row persisted)
 *   - tenant paused (rejected, no row persisted)
 *   - already-released escrow
 *   - idempotency key collision (returns existing entry, no double-insert)
 *   - invariant enforcement ON SAVE (throws before persist)
 *   - invariant enforcement ON READ (checkInvariantForBooking)
 *   - hash chain tamper detection
 *   - genesis row enforcement
 *   - netRefund=0 short-circuit
 *   - pipe character sanitisation in any user-controlled field
 *   - CancellationReversalNetRefundNotRegisteredError when policy unset
 */

import { jest } from "@jest/globals";
import type {
  CancellationReversalEntry,
  InsertCancellationReversalInput,
} from "../../../types/cancellationReversal.js";
import {
  CancellationReversalService,
  deriveReversalEntryHash,
  verifyChain,
  TenantPausedError,
  CancellationReversalCurrencyMismatchError,
  CancellationReversalInvariantViolationError,
  CancellationReversalNetRefundNotRegisteredError,
} from "../cancellation-reversal-service.js";
import {
  InMemoryCancellationReversalRepository,
  PgCancellationReversalRepository,
  type QueryFn,
} from "../pg-cancellation-reversal-repository.js";

type Currency = "USD" | "EUR" | "GBP" | "XLM";

// Suppress audit writes during tests.
// (jest.mock is statically hoisted by jest-ts BEFORE any of the
// static imports above, so the service's import of defaultAuditLogger
// is rewritten to the mock piped below.)
jest.mock("../../../services/auditLogger.js", () => ({
  defaultAuditLogger: {
    // jest@29's TypeScript types only accept a single generic on
    // `jest.fn()`, so cast through `as never` to satisfy strict mode.
    // Runtime semantics are unaffected.
    log: jest.fn().mockResolvedValue(undefined as never),
  },
}));

// ─── Test fixtures ───────────────────────────────────────────────────────────

function makeInput(
  overrides: Partial<InsertCancellationReversalInput> = {},
): InsertCancellationReversalInput {
  return {
    bookingIntentId: "intent-1",
    paymentId: "pay-USD-A",
    originalRefundId: "refund-1",
    amountCents: -1500,
    currency: "USD",
    escrowReleased: false,
    escrowReleasedAmountCents: 0,
    reason: "prorated_cancellation",
    idempotencyKey: "idem-1",
    policyVersionId: "v2-prorated",
    actor: "user-1",
    metadata: { tenantId: "tenant-A" },
    ...overrides,
  };
}

function makeService(options?: {
  isTenantPaused?: (id: string) => boolean;
  netRefundOverride?: number | null;
  now?: () => Date;
  releaseEscrow?: (input: {
    paymentId: string;
    bookingIntentId: string;
    amountCents: number;
    currency: Currency;
  }) => Promise<string>;
}) {
  const repo = new InMemoryCancellationReversalRepository();
  const checkoutSessionLookup = {
    async getCurrency(paymentId: string): Promise<Currency | null> {
      if (paymentId === "pay-USD-A") return "USD";
      if (paymentId === "pay-EUR-B") return "EUR";
      return null;
    },
  };
  const service = new CancellationReversalService({
    repo,
    checkoutSessionLookup,
    isTenantPaused: options?.isTenantPaused ?? (() => false),
    netRefundLookup: {
      async getNetRefund() {
        return options?.netRefundOverride ?? 1500;
      },
    },
    now: options?.now ?? (() => new Date("2026-02-01T00:00:00Z")),
    releaseEscrow: options?.releaseEscrow,
  });
  return { service, repo, checkoutSessionLookup };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("CancellationReversalService — appendEntry", () => {
  it("appends a reversal entry, advances the chain, and returns the entry", async () => {
    const { service, repo } = makeService();

    const entry = await service.appendEntry(makeInput());

    expect(entry.id).toBeTruthy();
    expect(entry.entryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.prevHash).toBe(""); // genesis row
    expect(entry.amountCents).toBe(-1500);
    expect(entry.currency).toBe("USD");

    const stored = await repo.findByPaymentId("pay-USD-A");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      bookingIntentId: "intent-1",
      idempotencyKey: "idem-1",
    });
  });

  it("chains successive entries with prev_hash = previous entry_hash", async () => {
    // Three entries whose sum (-1500 + -200 + 200 = -1500) reconciles to
    // the default netRefund=1500 — pre-write invariant approves all
    // three appends.
    const { service } = makeService();
    const first = await service.appendEntry(
      makeInput({ idempotencyKey: "k1", amountCents: -1500 }),
    );
    const second = await service.appendEntry(
      makeInput({
        idempotencyKey: "k2",
        originalRefundId: "refund-2",
        amountCents: -200,
      }),
    );
    const third = await service.appendEntry(
      makeInput({
        idempotencyKey: "k3",
        originalRefundId: "refund-3",
        amountCents: 200,
      }),
    );

    expect(first.prevHash).toBe("");
    expect(second.prevHash).toBe(first.entryHash);
    expect(third.prevHash).toBe(second.entryHash);

    const chain = await service.verifyChainForPayment("pay-USD-A");
    expect(chain.valid).toBe(true);
    expect(chain.entriesChecked).toBe(3);
  });

  it("returns the existing entry on idempotency-key collision (no double-insert)", async () => {
    const { service, repo } = makeService();
    const first = await service.appendEntry(
      makeInput({ idempotencyKey: "samekey" }),
    );
    const replay = await service.appendEntry(
      makeInput({ idempotencyKey: "samekey" }),
    );

    expect(replay).toMatchObject({ id: first.id });

    const stored = await repo.findByPaymentId("pay-USD-A");
    expect(stored).toHaveLength(1);
  });

  it("throws CancellationReversalInvariantViolationError BEFORE persisting when the new sum is wrong", async () => {
    const { service, repo } = makeService();
    await expect(
      service.appendEntry(
        makeInput({ idempotencyKey: "k1", amountCents: -300 }), // != -netRefund (=-1500)
      ),
    ).rejects.toBeInstanceOf(CancellationReversalInvariantViolationError);

    expect(await repo.findByPaymentId("pay-USD-A")).toHaveLength(0);
  });

  it("throws CancellationReversalNetRefundNotRegisteredError when netRefund policy is unset (strict mode)", async () => {
    const { service, repo } = makeService({ netRefundOverride: null });
    await expect(
      service.appendEntry(makeInput({ idempotencyKey: "k1" })),
    ).rejects.toBeInstanceOf(
      CancellationReversalNetRefundNotRegisteredError,
    );

    expect(await repo.findByPaymentId("pay-USD-A")).toHaveLength(0);
  });
});

describe("CancellationReversalService — guards", () => {
  it("rejects currency mismatch without persisting", async () => {
    const { service, repo } = makeService();
    await expect(
      service.appendEntry(
        makeInput({
          paymentId: "pay-EUR-B", // Session currency is EUR
          currency: "USD", // Entry currency mismatches
          idempotencyKey: "cur-mismatch",
        }),
      ),
    ).rejects.toBeInstanceOf(CancellationReversalCurrencyMismatchError);

    expect(await repo.findByPaymentId("pay-USD-A")).toHaveLength(0);
  });

  it("rejects tenant-paused without persisting", async () => {
    const { service, repo } = makeService({
      isTenantPaused: (id: string) => id === "tenant-A",
    });
    await expect(
      service.appendEntry(makeInput({ idempotencyKey: "tp-1" })),
    ).rejects.toBeInstanceOf(TenantPausedError);

    expect(await repo.findByPaymentId("pay-USD-A")).toHaveLength(0);
  });

  it("rejects zero amount without persisting", async () => {
    const { service, repo } = makeService();
    await expect(
      service.appendEntry(
        makeInput({ idempotencyKey: "zero-amount", amountCents: 0 }),
      ),
    ).rejects.toThrow(/non-zero integer/);

    expect(await repo.findByPaymentId("pay-USD-A")).toHaveLength(0);
  });

  it("rejects negative escrowReleasedAmountCents without persisting", async () => {
    const { service, repo } = makeService();
    await expect(
      service.appendEntry(
        makeInput({
          idempotencyKey: "neg-escrow",
          escrowReleasedAmountCents: -1,
          escrowReleased: true,
        }),
      ),
    ).rejects.toThrow(/>= 0/);

    expect(await repo.findByPaymentId("pay-USD-A")).toHaveLength(0);
  });
});

describe("CancellationReversalService — escrow state", () => {
  it("records an 'already_released' entry without producing a tx id", async () => {
    const { service } = makeService();
    const entry = await service.appendEntry(
      makeInput({
        idempotencyKey: "already-released",
        escrowReleased: false,
        escrowReleasedAmountCents: 0,
        reason: "escrow_already_released",
      }),
    );

    expect(entry.escrowReleased).toBe(false);
    expect(entry.escrowReleaseTxId).toBeUndefined();
    expect(entry.reason).toBe("escrow_already_released");
  });

  it("calls the escrow release hook when escrowReleased=true and no tx id is supplied", async () => {
    const releaseEscrow = jest.fn(async () => "tx-real-1");
    const { service } = makeService({ releaseEscrow });

    const entry = await service.appendEntry(
      makeInput({
        idempotencyKey: "release-hook",
        escrowReleased: true,
        escrowReleasedAmountCents: 1500,
      }),
    );

    expect(releaseEscrow).toHaveBeenCalledTimes(1);
    expect(entry.escrowReleaseTxId).toBe("tx-real-1");
  });
});

describe("CancellationReversalService — invariant", () => {
  it("reports 'valid' when sumReversalCents === -netRefund", async () => {
    const { service } = makeService();
    await service.appendEntry(
      makeInput({ idempotencyKey: "k1", amountCents: -1500 }),
    );

    const result = await service.checkInvariantForBooking("intent-1", "USD");
    expect(result.valid).toBe(true);
    expect(result.sumReversalCents).toBe(-1500);
    expect(result.expectedNegationOfNetRefund).toBe(-1500);
    expect(result.reason).toBeUndefined();
  });

  it("reports 'invalid' when ledger sum does not equal -netRefund", async () => {
    const repo = new InMemoryCancellationReversalRepository();
    // Seed a non-conforming entry via the repo (bypassing the pre-write
    // invariant so we can simulate a tampered / out-of-order ledger).
    await repo.insert({
      id: "seed-1",
      bookingIntentId: "intent-1",
      paymentId: "pay-USD-A",
      amountCents: -300,
      currency: "USD",
      escrowReleased: false,
      escrowReleasedAmountCents: 0,
      reason: "prorated_cancellation",
      idempotencyKey: "seed",
      policyVersionId: "v2-prorated",
      actor: "user-1",
      metadata: { tenantId: "tenant-A" },
      prevHash: "",
      entryHash: deriveReversalEntryHash(
        {
          id: "seed-1",
          bookingIntentId: "intent-1",
          paymentId: "pay-USD-A",
          amountCents: -300,
          currency: "USD",
          escrowReleased: false,
          escrowReleasedAmountCents: 0,
          reason: "prorated_cancellation",
          idempotencyKey: "seed",
          policyVersionId: "v2-prorated",
          actor: "user-1",
          metadata: { tenantId: "tenant-A" },
          prevHash: "",
        },
        new Date("2026-01-01T00:00:00Z"),
      ),
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const service = new CancellationReversalService({
      repo,
      checkoutSessionLookup: {
        async getCurrency() {
          return "USD";
        },
      },
      netRefundLookup: { async getNetRefund() { return 1500; } },
    });

    const result = await service.checkInvariantForBooking("intent-1", "USD");
    expect(result.valid).toBe(false);
    expect(result.sumReversalCents).toBe(-300);
    expect(result.expectedNegationOfNetRefund).toBe(-1500);
    expect(result.reason).toBeDefined();
  });

  it("rebuilds invariant on trace and merges reversal data into the net field", async () => {
    const { service } = makeService();
    await service.appendEntry(
      makeInput({ idempotencyKey: "k1", amountCents: -1500 }),
    );

    const trace = await service.buildPaymentReversalTrace({
      paymentId: "pay-USD-A",
      paymentsCurrency: "USD",
      refunds: [
        {
          id: "r1",
          amountCents: 1500,
          reason: "prorated_cancellation",
          status: "completed",
          createdAt: 1700000000,
        },
      ],
    });

    expect(trace.netAcrossOriginalAndReversalCents).toBe(0);
    expect(trace.invariantValid).toBe(true);
    expect(trace.reversals).toHaveLength(1);
  });
});

describe("CancellationReversalService — hash chain", () => {
  it("detects tampering via verifyChain (mismatched entryHash)", async () => {
    const { service, repo } = makeService();
    const entry = await service.appendEntry(
      makeInput({ idempotencyKey: "k1", amountCents: -1500 }),
    );

    const replaced = await repo._replace(entry.id, {
      entryHash: "deadbeef".repeat(8),
    });
    expect(replaced).not.toBeNull();

    const result = await service.verifyChainForPayment("pay-USD-A");
    expect(result.valid).toBe(false);
    expect(result.firstBrokenIndex).toBe(0);
    expect(result.error).toMatch(/hash mismatch/i);
  });

  it("detects chain breaks via prevHash pointing at the wrong predecessor", async () => {
    // Sum of -1500 + -200 = -1700, so netRefund override 1700 keeps
    // both inserts inside the strict invariant.
    const { service, repo } = makeService({ netRefundOverride: 1700 });

    await service.appendEntry(
      makeInput({ idempotencyKey: "k1", amountCents: -1500 }),
    );
    await service.appendEntry(
      makeInput({ idempotencyKey: "k2", amountCents: -200 }),
    );

    const stored = await repo.findByPaymentId("pay-USD-A");
    const replaced = await repo._replace(stored[1].id, {
      prevHash: "0".repeat(64),
    });
    expect(replaced).not.toBeNull();

    const result = await service.verifyChainForPayment("pay-USD-A");
    expect(result.valid).toBe(false);
    expect(result.firstBrokenIndex).toBe(1);
  });

  it("verifyChain passes for an empty ledger", async () => {
    const { service } = makeService();
    const result = await service.verifyChainForPayment("pay-emptypay");
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(0);
  });

  it("deriveReversalEntryHash is deterministic for equivalent inputs", () => {
    const base: Omit<CancellationReversalEntry, "entryHash"> = {
      id: "id-1",
      bookingIntentId: "intent-1",
      paymentId: "pay-A",
      amountCents: -1500,
      currency: "USD",
      escrowReleased: false,
      escrowReleasedAmountCents: 0,
      reason: "prorated_cancellation",
      idempotencyKey: "k1",
      policyVersionId: "v2-prorated",
      actor: "user-1",
      metadata: {},
      prevHash: "",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    const h1 = deriveReversalEntryHash(base, base.createdAt);
    const h2 = deriveReversalEntryHash(base, base.createdAt);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifyChain rejects a genesis row with non-empty prevHash", () => {
    const bogus: CancellationReversalEntry = {
      id: "id-1",
      bookingIntentId: "intent-1",
      paymentId: "pay-A",
      amountCents: -1500,
      currency: "USD",
      escrowReleased: false,
      escrowReleasedAmountCents: 0,
      reason: "prorated_cancellation",
      idempotencyKey: "k1",
      policyVersionId: "v2-prorated",
      actor: "user-1",
      metadata: {},
      prevHash: "deadbeef",
      entryHash: "0".repeat(64),
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    const result = verifyChain([bogus]);
    expect(result.valid).toBe(false);
    expect(result.firstBrokenIndex).toBe(0);
  });

  it("sanitises pipe characters in `reason`", async () => {
    // Two entries with cumulative sum -1500 → netRefund override 3000
    // so both inserts pass the pre-write invariant.
    const { service, repo } = makeService({ netRefundOverride: 3000 });

    const withPipe = await service.appendEntry(
      makeInput({ idempotencyKey: "piped-reason-1", reason: "a|b|c" }),
    );
    const withoutPipe = await service.appendEntry(
      makeInput({
        idempotencyKey: "piped-reason-2",
        reason: "a\u0000b\u0000c", // already pre-sanitised
      }),
    );

    // The two hashes are IDENTICAL because only the pipe differs and
    // the sanitiser strips it before hashing. The persisted records
    // keep the original bytes so audit history is preserved.
    expect(withPipe.entryHash).toBe(withoutPipe.entryHash);
    expect(withPipe.reason).toBe("a|b|c");

    const stored = await repo.findByPaymentId("pay-USD-A");
    expect(stored.map((e) => e.reason).sort()).toEqual(
      ["a\u0000b\u0000c", "a|b|c"].sort(),
    );
  });

  it("sanitises pipe characters in `actor` and `idempotencyKey`", async () => {
    // Two entries of -1500 → cumulative sum -3000 → netRefund override 3000.
    const { service, repo } = makeService({ netRefundOverride: 3000 });

    const a = await service.appendEntry(
      makeInput({
        idempotencyKey: "k|pipe",
        actor: "user|with|pipes",
      }),
    );
    const b = await service.appendEntry(
      makeInput({
        idempotencyKey: "k\u0000pipe",
        actor: "user\u0000with\u0000pipes",
      }),
    );
    expect(a.entryHash).toBe(b.entryHash);

    // Stored values retain the original (unsanitised) bytes.
    const stored = await repo.findByPaymentId("pay-USD-A");
    expect(stored).toHaveLength(2);
    const first = stored.find((e) => e.idempotencyKey === "k|pipe");
    const second = stored.find((e) => e.idempotencyKey === "k\u0000pipe");
    expect(first?.actor).toBe("user|with|pipes");
    expect(second?.actor).toBe("user\u0000with\u0000pipes");
  });
});

describe("CancellationReversalService — recordSkippedZeroAmount", () => {
  it("emits an audit log without persisting (netRefund == 0 path)", async () => {
    const { service, repo } = makeService();
    await service.recordSkippedZeroAmount({
      bookingIntentId: "intent-1",
      paymentId: "pay-USD-A",
      currency: "USD",
      reason: "prorated_cancellation",
      actor: "user-1",
    });

    expect(await repo.findByPaymentId("pay-USD-A")).toHaveLength(0);
  });
});

describe("CancellationReversalService — buildPaymentReversalTrace", () => {
  it("returns clean invariant when ledger is empty and refunds are zero", async () => {
    const { service } = makeService();

    const trace = await service.buildPaymentReversalTrace({
      paymentId: "pay-empty",
      paymentsCurrency: "USD",
      refunds: [],
    });

    expect(trace.netAcrossOriginalAndReversalCents).toBe(0);
    expect(trace.invariantValid).toBe(true);
    expect(trace.reversals).toHaveLength(0);
  });

  it("sign-aware NET combines refund positive + reversal negative correctly", async () => {
    // Sum: -1500 + 200 = -1300; netRefund override 1300 so this passes
    // the pre-write invariant.
    const { service } = makeService({ netRefundOverride: 1300 });

    await service.appendEntry(
      makeInput({ idempotencyKey: "k1", amountCents: -1500 }),
    );
    await service.appendEntry(
      makeInput({ idempotencyKey: "k2-partial-correction", amountCents: 200 }),
    );

    const trace = await service.buildPaymentReversalTrace({
      paymentId: "pay-USD-A",
      paymentsCurrency: "USD",
      refunds: [
        {
          id: "r1",
          amountCents: 1500,
          status: "completed",
          createdAt: 1700000000,
        },
      ],
    });

    // Refund = +1500, reversals = -1500 + 200 = -1300 => NET = 200
    expect(trace.netAcrossOriginalAndReversalCents).toBe(200);
    expect(trace.invariantValid).toBe(true);
  });
});

describe("PgCancellationReversalRepository — unique-violation mapping", () => {
  type PgErr = Error & { code?: string; constraint?: string };

  function buildRepoWithFailure(failWith: PgErr): {
    dbQuery: jest.Mock;
    repo: PgCancellationReversalRepository;
  } {
    // jest@29's TypeScript types only accept a single generic on
    // `jest.fn()`; cast `failWith` through `as never` to satisfy strict
    // mode. The mock is then re-cast to `QueryFn` for the PG repo's
    // constructor. Runtime semantics are unchanged.
    const dbQuery = jest.fn().mockRejectedValueOnce(failWith as never);
    const repo = new PgCancellationReversalRepository(
      dbQuery as unknown as QueryFn,
    );
    return { dbQuery, repo };
  }

  const baseEntry: CancellationReversalEntry = {
    id: "id-1",
    bookingIntentId: "intent-1",
    paymentId: "pay-A",
    amountCents: -1500,
    currency: "USD",
    escrowReleased: false,
    escrowReleasedAmountCents: 0,
    reason: "prorated_cancellation",
    idempotencyKey: "idon",
    policyVersionId: "v2-prorated",
    actor: "user-1",
    metadata: {},
    prevHash: "",
    entryHash: "0".repeat(64),
    createdAt: new Date(),
  };

  it("translates pg UNIQUE violation on idempotency_key to a typed error", async () => {
    const { dbQuery, repo } = buildRepoWithFailure(
      Object.assign(new Error("dup"), {
        code: "23505",
        constraint: "cancellation_reversal_entries_idempotency_key_key",
      }) as PgErr,
    );

    await expect(repo.insert(baseEntry)).rejects.toThrow(/idempotency_key/);
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it("translates pg UNIQUE violation on entry_hash to a typed error", async () => {
    const { repo } = buildRepoWithFailure(
      Object.assign(new Error("dup"), {
        code: "23505",
        constraint: "cancellation_reversal_entries_entry_hash_key",
      }) as PgErr,
    );

    await expect(
      repo.insert({
        ...baseEntry,
        idempotencyKey: "k-h",
        entryHash: "f".repeat(64),
      }),
    ).rejects.toThrow(/entry hash collision/i);
  });
});
