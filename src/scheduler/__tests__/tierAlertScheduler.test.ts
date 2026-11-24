import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { logger } from "../../utils/logger.js";
import type {
  AlertEvaluationResult,
  SupplierTierAlert,
  SupplierTierAlertService,
} from "../../services/supplierTierAlertService.js";
import { TierAlertScheduler, createTierAlertScheduler } from "../tierAlertScheduler.js";

function makeAlert(id: string): SupplierTierAlert {
  return {
    id,
    supplierId: "supplier-1",
    alertType: "approach",
    fromTier: "Standard",
    toTier: "Top Rated",
    boundaryScore: 90,
    currentScore: 89,
    distanceToBoundary: 1,
    message: "Approaching Top Rated",
    createdAt: "2026-01-01T00:00:00.000Z",
    acknowledged: false,
  };
}

function makeResult(alerts: SupplierTierAlert[] = []): AlertEvaluationResult {
  return {
    supplierId: "supplier-1",
    previousScore: 88,
    currentScore: 89,
    previousTier: "Standard",
    currentTier: "Standard",
    alerts,
  };
}

function stubService(
  enabled: boolean,
  evaluateAllSuppliers: () => Promise<AlertEvaluationResult[]>,
): SupplierTierAlertService {
  return {
    isEnabled: () => enabled,
    evaluateAllSuppliers,
  } as unknown as SupplierTierAlertService;
}

describe("TierAlertScheduler", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("creates a scheduler instance", () => {
    expect(createTierAlertScheduler()).toBeInstanceOf(TierAlertScheduler);
  });

  it("runOnce returns [] and does not evaluate when the service is disabled", async () => {
    const evaluateAllSuppliers = jest.fn<() => Promise<AlertEvaluationResult[]>>();
    const onBatchComplete = jest.fn();
    const scheduler = new TierAlertScheduler({
      service: stubService(false, evaluateAllSuppliers),
      onBatchComplete,
    });

    await expect(scheduler.runOnce()).resolves.toEqual([]);
    expect(evaluateAllSuppliers).not.toHaveBeenCalled();
    expect(onBatchComplete).not.toHaveBeenCalled();
  });

  it("runs once with the service and reports alerts and batch results", async () => {
    const alert = makeAlert("alert-1");
    const result = makeResult([alert]);
    const service = stubService(true, jest.fn(async () => [result]));
    const onAlert = jest.fn();
    const onBatchComplete = jest.fn();
    const scheduler = createTierAlertScheduler({ service, onAlert, onBatchComplete });

    await expect(scheduler.runOnce()).resolves.toEqual([result]);
    expect(onAlert).toHaveBeenCalledWith(alert);
    expect(onBatchComplete).toHaveBeenCalledWith([result]);
  });

  it("runOnce invokes onAlert once per alert and onBatchComplete once", async () => {
    const alert1 = makeAlert("alert-1");
    const alert2 = makeAlert("alert-2");
    const result = makeResult([alert1, alert2]);
    const onAlert = jest.fn();
    const onBatchComplete = jest.fn();
    const scheduler = new TierAlertScheduler({
      service: stubService(true, async () => [result]),
      onAlert,
      onBatchComplete,
    });

    await expect(scheduler.runOnce()).resolves.toEqual([result]);
    expect(onAlert).toHaveBeenCalledTimes(2);
    expect(onAlert).toHaveBeenNthCalledWith(1, alert1);
    expect(onAlert).toHaveBeenNthCalledWith(2, alert2);
    expect(onBatchComplete).toHaveBeenCalledTimes(1);
    expect(onBatchComplete).toHaveBeenCalledWith([result]);
  });

  it("start is idempotent and stop cancels the timer", async () => {
    const evaluateAllSuppliers = jest.fn(async () => [makeResult()]);
    const scheduler = new TierAlertScheduler({
      service: stubService(true, evaluateAllSuppliers),
      runIntervalMs: 1000,
    });

    scheduler.start();
    scheduler.start();
    await jest.advanceTimersByTimeAsync(0);

    expect(evaluateAllSuppliers).toHaveBeenCalledTimes(1);
    expect(scheduler.getRunCount()).toBe(1);
    expect(jest.getTimerCount()).toBe(1);

    scheduler.stop();
    await jest.advanceTimersByTimeAsync(5000);

    expect(scheduler.isActive()).toBe(false);
    expect(evaluateAllSuppliers).toHaveBeenCalledTimes(1);
  });

  it("ticks on the configured interval and stops after maxRuns", async () => {
    const evaluateAllSuppliers = jest.fn(async () => [makeResult()]);
    const onBatchComplete = jest.fn();
    const scheduler = new TierAlertScheduler({
      service: stubService(true, evaluateAllSuppliers),
      runIntervalMs: 1000,
      onBatchComplete,
      maxRuns: 2,
    });

    scheduler.start();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);

    expect(scheduler.getRunCount()).toBe(2);
    expect(evaluateAllSuppliers).toHaveBeenCalledTimes(2);
    expect(onBatchComplete).toHaveBeenCalledTimes(2);
    expect(scheduler.isActive()).toBe(false);
  });

  it("logs and swallows a rejection, then continues at the next tick", async () => {
    const errorSpy = jest.spyOn(logger, "error").mockImplementation(() => undefined as never);
    const evaluateAllSuppliers = jest
      .fn<() => Promise<AlertEvaluationResult[]>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce([makeResult()]);
    const scheduler = new TierAlertScheduler({
      service: stubService(true, evaluateAllSuppliers),
      runIntervalMs: 1000,
    });

    scheduler.start();
    await jest.advanceTimersByTimeAsync(0);

    expect(scheduler.getRunCount()).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      "[tier-alert-scheduler] Batch evaluation failed",
    );

    await jest.advanceTimersByTimeAsync(1000);

    expect(scheduler.getRunCount()).toBe(2);
    expect(evaluateAllSuppliers).toHaveBeenCalledTimes(2);
    expect(scheduler.isActive()).toBe(true);

    scheduler.stop();
  });
});
