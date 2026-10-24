import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  SettlementReconciler,
  startSettlementReconciler,
  _settlements,
  settlementEvents,
} from "../settlementReconciler.js";
import { settlementsPendingFinality } from "../../metrics.js";
import { payoutRetryRollup } from "../../scheduler/payoutRetryMetrics.js";
import { providerRetryRegistry } from "../../scheduler/payoutRetryPolicy.js";
import type { ChainFinalityStatus } from "../../clients/horizon-contract-client.js";

interface ProbeMock {
  getLatestLedgerSequence: jest.Mock<() => Promise<number>>;
  getTransactionFinality: jest.Mock<
    (txHash: string, options?: { latestLedger?: number }) => Promise<ChainFinalityStatus>
  >;
}

function makeProbeMock(): ProbeMock {
  return {
    getLatestLedgerSequence: jest.fn() as any,
    getTransactionFinality: jest.fn() as any,
  };
}

describe("SettlementReconciler Worker & Service", () => {
  let mockHorizonClient: ProbeMock;
  let reconciler: SettlementReconciler;
  const transactionId = "txn-test-hash-123";

  beforeEach(() => {
    _settlements.clear();
    settlementEvents.removeAllListeners();
    jest.clearAllMocks();
    payoutRetryRollup.reset();
    providerRetryRegistry.clear();

    mockHorizonClient = makeProbeMock();

    reconciler = new SettlementReconciler(mockHorizonClient as any, {
      minConfirmations: 3,
      maxAttempts: 5,
      pollIntervalMs: 5000,
    });
  });

  afterEach(() => {
    reconciler.stop();
  });

  function ledger(sequence = 1008) {
    mockHorizonClient.getLatestLedgerSequence.mockResolvedValueOnce(sequence as never);
  }

  function probeNotFound() {
    mockHorizonClient.getTransactionFinality.mockResolvedValueOnce({
      found: false,
      txHash: transactionId,
      confirmations: 0,
      latestLedger: 1008,
    } as never);
  }

  function probeTx(overrides: Partial<ChainFinalityStatus> = {}) {
    const base: ChainFinalityStatus = {
      found: true,
      txHash: transactionId,
      successful: true,
      ledger: 1005,
      latestLedger: 1008,
      confirmations: 4,
    };
    mockHorizonClient.getTransactionFinality.mockResolvedValueOnce({
      ...base,
      ...overrides,
    } as never);
  }

  function probeTransientError() {
    mockHorizonClient.getTransactionFinality.mockRejectedValueOnce(
      Object.assign(new Error("Horizon HTTP 503"), { statusCode: 503 }) as never,
    );
  }

  it("successfully starts and stops the reconciler worker loop", () => {
    reconciler.start();
    // @ts-expect-error - testing private instance variable status
    expect(reconciler.isRunning).toBe(true);
    // @ts-expect-error - testing private instance variable status
    expect(reconciler.intervalId).not.toBeNull();

    reconciler.stop();
    // @ts-expect-error - testing private instance variable status
    expect(reconciler.isRunning).toBe(false);
    // @ts-expect-error - testing private instance variable status
    expect(reconciler.intervalId).toBeNull();
  });

  it("advances settlement from pending_finality to payout_ready when MIN_LEDGER_CONFIRMATIONS are reached", async () => {
    _settlements.set(transactionId, {
      transactionId,
      eventType: "settlement_completed",
      amount: 250,
      timestamp: Date.now(),
      status: "pending_finality",
      confirmations: 0,
      attempts: 0,
    });

    // Latest ledger = 1008; tx ledger = 1005 → probe reports 4 confirmations
    ledger(1008);
    probeTx({ ledger: 1005, latestLedger: 1008, confirmations: 4 });

    await reconciler.reconcile();

    const settlement = _settlements.get(transactionId);
    expect(settlement).toBeDefined();
    expect(settlement?.status).toBe("payout_ready");
    expect(settlement?.confirmations).toBe(4);
    expect(settlement?.ledgerNumber).toBe(1005);

    // Verify gauge is updated to 0 (no more pending)
    expect((await settlementsPendingFinality.get()).values[0]?.value ?? 0).toBe(0);
  });

  it("keeps settlement in pending_finality if confirmations are below MIN_LEDGER_CONFIRMATIONS", async () => {
    _settlements.set(transactionId, {
      transactionId,
      eventType: "settlement_completed",
      amount: 250,
      timestamp: Date.now(),
      status: "pending_finality",
      confirmations: 0,
      attempts: 0,
    });

    // Latest ledger = 1006; tx ledger = 1005 → probe reports 2 confirmations < 3
    ledger(1006);
    probeTx({ ledger: 1005, latestLedger: 1006, confirmations: 2 });

    await reconciler.reconcile();

    const settlement = _settlements.get(transactionId);
    expect(settlement?.status).toBe("pending_finality");
    expect(settlement?.confirmations).toBe(2);

    // Verify gauge still shows 1 pending
    expect((await settlementsPendingFinality.get()).values[0]?.value ?? 0).toBe(1);
  });

  it("marks payout_ready exactly when confirmations equal MIN_LEDGER_CONFIRMATIONS (boundary)", async () => {
    _settlements.set(transactionId, {
      transactionId,
      eventType: "settlement_completed",
      amount: 250,
      timestamp: Date.now(),
      status: "pending_finality",
      confirmations: 0,
      attempts: 0,
    });

    ledger(1008);
    probeTx({ ledger: 1006, latestLedger: 1008, confirmations: 3 });

    await reconciler.reconcile();

    expect(_settlements.get(transactionId)?.status).toBe("payout_ready");
    expect(_settlements.get(transactionId)?.confirmations).toBe(3);
  });

  it("respects jittered backoff delay before polling Horizon again", async () => {
    // Use _now and _random overrides so the backoff gate is deterministic.
    // alwaysMax random (0.9999) → delayMs ≈ capMs for attempt 2 with base=1000, mult=2:
    //   cap = min(30000, 1000 * 2^2) = 4000ms; delay ≈ 4000ms
    // We set _now to return a fixed timestamp 100ms after lastPolledAt,
    // so elapsed (100ms) < delay (~4000ms) → gate must skip the poll.
    const lastPolledAt = 1_000_000;
    const fixedNow = lastPolledAt + 100; // only 100ms elapsed
    const alwaysMax = () => 0.9999;

    // Rebuild reconciler with deterministic clock and random
    reconciler.stop();
    reconciler = new SettlementReconciler(mockHorizonClient as any, {
      minConfirmations: 3,
      maxAttempts: 5,
      pollIntervalMs: 5000,
      _now: () => fixedNow,
      _random: alwaysMax,
    });

    _settlements.set(transactionId, {
      transactionId,
      eventType: "settlement_completed",
      amount: 250,
      timestamp: Date.now(),
      status: "pending_finality",
      confirmations: 0,
      attempts: 2,
      lastPolledAt,
    });

    ledger(1008);

    await reconciler.reconcile();

    // Latest ledger was queried, but the backoff gate skips getTransactionFinality
    expect(mockHorizonClient.getLatestLedgerSequence).toHaveBeenCalledTimes(1);
    expect(mockHorizonClient.getTransactionFinality).not.toHaveBeenCalled();
    const settlement = _settlements.get(transactionId);
    expect(settlement?.attempts).toBe(2);
    expect(settlement?.lastPolledAt).toBe(lastPolledAt);
  });

  it("marks settlement as failed if transaction failed on-chain", async () => {
    _settlements.set(transactionId, {
      transactionId,
      eventType: "settlement_completed",
      amount: 250,
      timestamp: Date.now(),
      status: "pending_finality",
      confirmations: 0,
      attempts: 0,
    });

    ledger(1008);
    probeTx({ successful: false });

    await reconciler.reconcile();

    const settlement = _settlements.get(transactionId);
    expect(settlement?.status).toBe("failed");
  });

  it("increments attempts and flags failed status when transaction is missing from Horizon after max attempts", async () => {
    _settlements.set(transactionId, {
      transactionId,
      eventType: "settlement_completed",
      amount: 250,
      timestamp: Date.now(),
      status: "pending_finality",
      confirmations: 0,
      attempts: 4, // Next failure will make it 5 >= maxAttempts
    });

    ledger(1008);
    // Probe reports the transaction is simply not known (not an exception)
    probeNotFound();

    await reconciler.reconcile();

    const settlement = _settlements.get(transactionId);
    expect(settlement?.status).toBe("failed");
    expect(settlement?.attempts).toBe(5);
  });

  it("does not exhaust attempts while the transaction is merely not yet visible", async () => {
    _settlements.set(transactionId, {
      transactionId,
      eventType: "settlement_completed",
      amount: 250,
      timestamp: Date.now(),
      status: "pending_finality",
      confirmations: 0,
      attempts: 0,
    });

    ledger(1008);
    probeNotFound();

    await reconciler.reconcile();

    const settlement = _settlements.get(transactionId);
    expect(settlement?.status).toBe("pending_finality");
    expect(settlement?.attempts).toBe(1);
  });

  it("keeps settlement pending on a transient Horizon error and does not increment attempts", async () => {
    _settlements.set(transactionId, {
      transactionId,
      eventType: "settlement_completed",
      amount: 250,
      timestamp: Date.now(),
      status: "pending_finality",
      confirmations: 0,
      attempts: 1,
    });

    ledger(1008);
    probeTransientError();

    await reconciler.reconcile();

    const settlement = _settlements.get(transactionId);
    expect(settlement?.status).toBe("pending_finality");
    expect(settlement?.attempts).toBe(1);
  });

  it("detects chain fork and raises alert event when payout_ready transaction subsequently disappears from Horizon", async () => {
    _settlements.set(transactionId, {
      transactionId,
      eventType: "settlement_completed",
      amount: 250,
      timestamp: Date.now(),
      status: "payout_ready",
      ledgerNumber: 1005,
      confirmations: 3,
      attempts: 0,
    });

    ledger(1008);
    probeNotFound();

    // Track the emitted alert event
    let alertEmitted: any = null;
    settlementEvents.on("alert", (payload) => {
      alertEmitted = payload;
    });

    await reconciler.reconcile();

    const settlement = _settlements.get(transactionId);
    expect(settlement?.status).toBe("reorg_flagged");
    expect(settlement?.forkAlertTriggered).toBe(true);

    expect(alertEmitted).not.toBeNull();
    expect(alertEmitted.type).toBe("FORK_DETECTED");
    expect(alertEmitted.settlementId).toBe(transactionId);
    expect(alertEmitted.message).toContain("vanished from the chain");
  });
});

// ─── Per-provider ceiling enforcement ────────────────────────────────────────

describe("SettlementReconciler — per-provider ceiling", () => {
  let mockHorizonClient: ProbeMock;
  let reconciler: SettlementReconciler;
  const txId = "txn-ceiling-test";

  // Fixed clock: lastPolledAt=0, _now always returns far-future so backoff
  // gate never skips (elapsed = huge >> any delay).
  const alwaysZero = () => 0; // jitter=0 → delayMs=0, gate always passes

  beforeEach(() => {
    _settlements.clear();
    settlementEvents.removeAllListeners();
    jest.clearAllMocks();
    payoutRetryRollup.reset();
    providerRetryRegistry.clear();

    mockHorizonClient = makeProbeMock();
  });

  afterEach(() => {
    reconciler?.stop();
  });

  function ledger(sequence = 1008) {
    mockHorizonClient.getLatestLedgerSequence.mockResolvedValueOnce(sequence as never);
  }

  function probeNotFound() {
    mockHorizonClient.getTransactionFinality.mockResolvedValueOnce({
      found: false,
      txHash: txId,
      confirmations: 0,
      latestLedger: 1008,
    } as never);
  }

  it("honours a tight provider ceiling — capMs is bounded by the registered ceiling", async () => {
    providerRetryRegistry.set("ach", {
      providerId: "ach",
      baseDelayMs: 1_000,
      multiplier: 2,
      maxDelayCeilingMs: 3_000, // tight ceiling
      maxRetries: 10,
    });

    reconciler = new SettlementReconciler(mockHorizonClient as any, {
      minConfirmations: 3,
      _now: () => Date.now() + 1_000_000, // far future → always past backoff
      _random: alwaysZero,
    });

    _settlements.set(txId, {
      transactionId: txId,
      eventType: "settlement_completed",
      amount: 100,
      timestamp: Date.now(),
      status: "pending_finality",
      confirmations: 0,
      attempts: 5, // without ceiling: cap = 1000*2^5 = 32_000 >> 3_000
      providerId: "ach",
    });

    ledger();
    probeNotFound();

    await reconciler.reconcile();

    // Ceiling_hit should have been recorded because cap was clamped to 3_000
    const snap = payoutRetryRollup.snapshot();
    expect(snap.ceilingHits).toBe(1);
    expect(snap.attempts).toBe(1);
  });

  it("records 'scheduled' outcome when cap is below the ceiling", async () => {
    providerRetryRegistry.set("sepa", {
      providerId: "sepa",
      baseDelayMs: 500,
      multiplier: 2,
      maxDelayCeilingMs: 60_000,
      maxRetries: 10,
    });

    reconciler = new SettlementReconciler(mockHorizonClient as any, {
      minConfirmations: 3,
      _now: () => Date.now() + 1_000_000,
      _random: alwaysZero,
    });

    _settlements.set(txId, {
      transactionId: txId,
      eventType: "settlement_completed",
      amount: 100,
      timestamp: Date.now(),
      status: "pending_finality",
      confirmations: 0,
      attempts: 1, // cap = 500*2^1 = 1_000 << ceiling of 60_000
      providerId: "sepa",
    });

    ledger();
    probeNotFound();

    await reconciler.reconcile();

    const snap = payoutRetryRollup.snapshot();
    expect(snap.scheduled).toBe(1);
    expect(snap.ceilingHits).toBe(0);
    expect(snap.exhausted).toBe(0);
  });

  it("records 'exhausted' and marks settlement failed when maxRetries reached", async () => {
    providerRetryRegistry.set("wire", {
      providerId: "wire",
      baseDelayMs: 1_000,
      multiplier: 2,
      maxDelayCeilingMs: 30_000,
      maxRetries: 3,
    });

    reconciler = new SettlementReconciler(mockHorizonClient as any, {
      minConfirmations: 3,
      _now: () => Date.now() + 1_000_000,
      _random: alwaysZero,
    });

    _settlements.set(txId, {
      transactionId: txId,
      eventType: "settlement_completed",
      amount: 100,
      timestamp: Date.now(),
      status: "pending_finality",
      confirmations: 0,
      attempts: 3, // nextAttempt=4 > maxRetries=3 → exhausted
      providerId: "wire",
    });

    ledger();
    probeNotFound();

    await reconciler.reconcile();

    const settlement = _settlements.get(txId);
    expect(settlement?.status).toBe("failed");
    expect(settlement?.attempts).toBe(4);

    const snap = payoutRetryRollup.snapshot();
    expect(snap.exhausted).toBe(1);
    expect(snap.attempts).toBe(1);
  });

  it("ceiling < base: ceiling is still honoured from the very first retry", async () => {
    // ceiling (200ms) < base (1_000ms) → cap is always 200ms regardless of attempt
    providerRetryRegistry.set("fast-rail", {
      providerId: "fast-rail",
      baseDelayMs: 1_000,
      multiplier: 2,
      maxDelayCeilingMs: 200,
      maxRetries: 10,
    });

    reconciler = new SettlementReconciler(mockHorizonClient as any, {
      minConfirmations: 3,
      _now: () => Date.now() + 1_000_000,
      _random: alwaysZero,
    });

    _settlements.set(txId, {
      transactionId: txId,
      eventType: "settlement_completed",
      amount: 100,
      timestamp: Date.now(),
      status: "pending_finality",
      confirmations: 0,
      attempts: 0,
      providerId: "fast-rail",
    });

    ledger();
    probeNotFound();

    await reconciler.reconcile();

    // ceiling < base → cap was clamped → ceiling_hit
    const snap = payoutRetryRollup.snapshot();
    expect(snap.ceilingHits).toBe(1);
  });

  it("multiple missing-transaction probes accumulate attempts and emit one metric per reconcile call", async () => {
    providerRetryRegistry.set("ach", {
      providerId: "ach",
      baseDelayMs: 1_000,
      multiplier: 2,
      maxDelayCeilingMs: 30_000,
      maxRetries: 10,
    });

    let callCount = 0;
    // _now increments so each call appears as a new time slice past any delay
    reconciler = new SettlementReconciler(mockHorizonClient as any, {
      minConfirmations: 3,
      _now: () => 1_000_000 + callCount++ * 1_000_000,
      _random: alwaysZero,
    });

    _settlements.set(txId, {
      transactionId: txId,
      eventType: "settlement_completed",
      amount: 100,
      timestamp: Date.now(),
      status: "pending_finality",
      confirmations: 0,
      attempts: 0,
      providerId: "ach",
    });

    // Three reconcile loops, each reporting the transaction as missing
    for (let i = 0; i < 3; i++) {
      ledger();
      probeNotFound();
      await reconciler.reconcile();
    }

    const settlement = _settlements.get(txId);
    expect(settlement?.attempts).toBe(3);

    const snap = payoutRetryRollup.snapshot();
    expect(snap.attempts).toBe(3);
  });

  it("falls back to default provider config when providerId is not in registry", async () => {
    // No entry registered for "unknown-provider" — should use defaults
    reconciler = new SettlementReconciler(mockHorizonClient as any, {
      minConfirmations: 3,
      maxAttempts: 5,
      _now: () => Date.now() + 1_000_000,
      _random: alwaysZero,
    });

    _settlements.set(txId, {
      transactionId: txId,
      eventType: "settlement_completed",
      amount: 100,
      timestamp: Date.now(),
      status: "pending_finality",
      confirmations: 0,
      attempts: 1,
      providerId: "unknown-provider",
    });

    ledger();
    probeNotFound();

    // Should not throw — defaults kick in
    await expect(reconciler.reconcile()).resolves.not.toThrow();

    const snap = payoutRetryRollup.snapshot();
    expect(snap.attempts).toBe(1);
  });
});

// ─── Boot helper ─────────────────────────────────────────────────────────────

describe("startSettlementReconciler", () => {
  it("constructs a reconciler with the injected probe and starts the poll loop", () => {
    const probe = makeProbeMock();

    const worker = startSettlementReconciler({
      horizonClient: probe as any,
      minConfirmations: 3,
      pollIntervalMs: 60_000,
    });

    expect(worker).toBeInstanceOf(SettlementReconciler);
    // @ts-expect-error - testing private instance variable status
    expect(worker.isRunning).toBe(true);
    // @ts-expect-error - testing private instance variable status
    expect(worker.intervalId).not.toBeNull();

    worker.stop();
    // @ts-expect-error - testing private instance variable status
    expect(worker.isRunning).toBe(false);
  });

  it("leaves probe invocation to the poll loop only (no eager reconcile on start)", () => {
    const probe = makeProbeMock();

    const worker = startSettlementReconciler({
      horizonClient: probe as any,
      pollIntervalMs: 60_000,
    });

    expect(probe.getLatestLedgerSequence).not.toHaveBeenCalled();
    expect(probe.getTransactionFinality).not.toHaveBeenCalled();

    worker.stop();
  });
});
