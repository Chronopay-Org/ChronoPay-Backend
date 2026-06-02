import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { SettlementReconciler, _settlements, settlementEvents } from "../settlementReconciler.js";
import { settlementsPendingFinality } from "../../metrics.js";

describe("SettlementReconciler Worker & Service", () => {
  let mockHorizonClient: any;
  let reconciler: SettlementReconciler;
  const transactionId = "txn-test-hash-123";

  beforeEach(() => {
    _settlements.clear();
    settlementEvents.removeAllListeners();
    jest.clearAllMocks();

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

  it("respects exponential backoff delay before polling Horizon again", async () => {
    const lastPolledAt = Date.now();
    _settlements.set(transactionId, {
      transactionId,
      eventType: "settlement_completed",
      amount: 250,
      timestamp: Date.now(),
      status: "pending_finality",
      confirmations: 0,
      attempts: 2, // backoff = 2^2 * 1000 = 4000ms
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

    // Latest ledger was queried, but backoff prevents querying getTransaction
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
