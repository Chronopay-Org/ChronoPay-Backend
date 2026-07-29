import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { SettlementReconciler, _settlements, settlementEvents } from "../settlementReconciler.js";
import { settlementsPendingFinality } from "../../metrics.js";
import { payoutRetryRollup } from "../../scheduler/payoutRetryMetrics.js";
import { providerRetryRegistry } from "../../scheduler/payoutRetryPolicy.js";

describe("SettlementReconciler Worker & Service", () => {
  let mockHorizonClient: any;
  let reconciler: SettlementReconciler;
  const transactionId = "txn-test-hash-123";

  beforeEach(() => {
    _settlements.clear();
    settlementEvents.removeAllListeners();
    jest.clearAllMocks();
    payoutRetryRollup.reset();
    providerRetryRegistry.clear();

    mockHorizonClient = {
      call: jest.fn() as any,
    };

    reconciler = new SettlementReconciler(mockHorizonClient as any, {
      minConfirmations: 3,
      maxAttempts: 5,
      pollIntervalMs: 5000,
    });
  });

  afterEach(() => {
    reconciler.stop();
  });

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

    // 1. Mock latest ledger = 1008
    mockHorizonClient.call.mockResolvedValueOnce({
      data: {
        _embedded: {
          records: [{ sequence: 1008 }],
        },
      },
    });

    // 2. Mock getTransaction returning tx ledger = 1005 (1008 - 1005 + 1 = 4 confirmations >= 3)
    mockHorizonClient.call.mockResolvedValueOnce({
      data: {
        id: transactionId,
        ledger: 1005,
        successful: true,
      },
    });

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

    // 1. Mock latest ledger = 1006
    mockHorizonClient.call.mockResolvedValueOnce({
      data: {
        _embedded: {
          records: [{ sequence: 1006 }],
        },
      },
    });

    // 2. Mock getTransaction returning tx ledger = 1005 (1006 - 1005 + 1 = 2 confirmations < 3)
    mockHorizonClient.call.mockResolvedValueOnce({
      data: {
        id: transactionId,
        ledger: 1005,
        successful: true,
      },
    });

    await reconciler.reconcile();

    const settlement = _settlements.get(transactionId);
    expect(settlement?.status).toBe("pending_finality");
    expect(settlement?.confirmations).toBe(2);

    // Verify gauge still shows 1 pending
    expect((await settlementsPendingFinality.get()).values[0]?.value ?? 0).toBe(1);
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

    mockHorizonClient.call.mockResolvedValueOnce({
      data: {
        _embedded: {
          records: [{ sequence: 1008 }],
        },
      },
    });

    await reconciler.reconcile();

    // Latest ledger was queried, but the backoff gate skips getTransaction
    expect(mockHorizonClient.call).toHaveBeenCalledTimes(1);
    expect(mockHorizonClient.call.mock.calls[0][0].method).toBe("getLatestLedger");
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

    mockHorizonClient.call.mockResolvedValueOnce({
      data: {
        _embedded: {
          records: [{ sequence: 1008 }],
        },
      },
    });

    // Mock successful: false returned from Horizon
    mockHorizonClient.call.mockResolvedValueOnce({
      data: {
        id: transactionId,
        ledger: 1005,
        successful: false,
      },
    });

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

    mockHorizonClient.call.mockResolvedValueOnce({
      data: {
        _embedded: {
          records: [{ sequence: 1008 }],
        },
      },
    });

    // Mock 404 error from Horizon client call
    const notFoundError = new Error("Horizon HTTP 404: transaction not found");
    (notFoundError as any).statusCode = 404;
    mockHorizonClient.call.mockRejectedValueOnce(notFoundError);

    await reconciler.reconcile();

    const settlement = _settlements.get(transactionId);
    expect(settlement?.status).toBe("failed");
    expect(settlement?.attempts).toBe(5);
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

    mockHorizonClient.call.mockResolvedValueOnce({
      data: {
        _embedded: {
          records: [{ sequence: 1008 }],
        },
      },
    });

    // Mock 404 error from Horizon client call
    const notFoundError = new Error("Horizon HTTP 404: transaction not found");
    (notFoundError as any).statusCode = 404;
    mockHorizonClient.call.mockRejectedValueOnce(notFoundError);

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
  let mockHorizonClient: any;
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

    mockHorizonClient = { call: jest.fn() as any };
  });

  afterEach(() => {
    reconciler?.stop();
  });

  function ledgerResponse(sequence = 1008) {
    return { data: { _embedded: { records: [{ sequence }] } } };
  }

  function notFoundError() {
    const e = new Error("Horizon HTTP 404: transaction not found");
    (e as any).statusCode = 404;
    return e;
  }

  it("honours a tight provider ceiling — capMs is bounded by the registered ceiling", async () => {
    providerRetryRegistry.set("ach", {
      providerId: "ach",
      baseDelayMs: 1_000,
      multiplier: 2,
      maxDelayCeilingMs: 3_000,   // tight ceiling
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
      attempts: 5,        // without ceiling: cap = 1000*2^5 = 32_000 >> 3_000
      providerId: "ach",
    });

    mockHorizonClient.call.mockResolvedValueOnce(ledgerResponse());
    mockHorizonClient.call.mockRejectedValueOnce(notFoundError());

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
      attempts: 1,    // cap = 500*2^1 = 1_000 << ceiling of 60_000
      providerId: "sepa",
    });

    mockHorizonClient.call.mockResolvedValueOnce(ledgerResponse());
    mockHorizonClient.call.mockRejectedValueOnce(notFoundError());

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
      attempts: 3,    // nextAttempt=4 > maxRetries=3 → exhausted
      providerId: "wire",
    });

    mockHorizonClient.call.mockResolvedValueOnce(ledgerResponse());
    mockHorizonClient.call.mockRejectedValueOnce(notFoundError());

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

    mockHorizonClient.call.mockResolvedValueOnce(ledgerResponse());
    mockHorizonClient.call.mockRejectedValueOnce(notFoundError());

    await reconciler.reconcile();

    // ceiling < base → cap was clamped → ceiling_hit
    const snap = payoutRetryRollup.snapshot();
    expect(snap.ceilingHits).toBe(1);
  });

  it("multiple 404s accumulate attempts and emit one metric per reconcile call", async () => {
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

    // Three reconcile loops, each returning 404
    for (let i = 0; i < 3; i++) {
      mockHorizonClient.call.mockResolvedValueOnce(ledgerResponse());
      mockHorizonClient.call.mockRejectedValueOnce(notFoundError());
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

    mockHorizonClient.call.mockResolvedValueOnce(ledgerResponse());
    mockHorizonClient.call.mockRejectedValueOnce(notFoundError());

    // Should not throw — defaults kick in
    await expect(reconciler.reconcile()).resolves.not.toThrow();

    const snap = payoutRetryRollup.snapshot();
    expect(snap.attempts).toBe(1);
  });
});
