import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  AlertEvaluationResult,
  SupplierTierAlert,
  SupplierTierAlertService,
} from "../../services/supplierTierAlertService.js";
import { TierAlertScheduler, createTierAlertScheduler } from "../tierAlertScheduler.js";

const alert: SupplierTierAlert = {
  id: "alert-1",
  supplierId: "supplier-42",
  alertType: "demotion",
  fromTier: "Top Rated",
  toTier: "Standard",
  boundaryScore: 75,
  currentScore: 74,
  distanceToBoundary: 1,
  message: "Tier changed",
  createdAt: "2026-01-01T00:00:00.000Z",
  acknowledged: false,
};

const result: AlertEvaluationResult = {
  supplierId: alert.supplierId,
  previousScore: 91,
  currentScore: 74,
  previousTier: "Top Rated",
  currentTier: "At Risk",
  alerts: [alert],
};

function makeService() {
  return {
    isEnabled: jest.fn(() => true),
    evaluateAllSuppliers: jest.fn(async () => [result]),
  } as unknown as SupplierTierAlertService;
}

describe("TierAlertScheduler", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("creates a scheduler instance", () => {
    expect(createTierAlertScheduler()).toBeInstanceOf(TierAlertScheduler);
  });

  it("runs once with the service and reports alerts and batch results", async () => {
    const service = makeService();
    const onAlert = jest.fn();
    const onBatchComplete = jest.fn();
    const scheduler = createTierAlertScheduler({ service, onAlert, onBatchComplete });

    await expect(scheduler.runOnce()).resolves.toEqual([result]);
    expect(service.evaluateAllSuppliers).toHaveBeenCalledTimes(1);
    expect(onAlert).toHaveBeenCalledWith(alert);
    expect(onBatchComplete).toHaveBeenCalledWith([result]);
  });

  it("starts once and stop clears the pending timer", async () => {
    jest.useFakeTimers();
    const service = makeService();
    const scheduler = createTierAlertScheduler({ service, runIntervalMs: 1000 });

    scheduler.start();
    scheduler.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(scheduler.getRunCount()).toBe(1);
    expect(service.evaluateAllSuppliers).toHaveBeenCalledTimes(1);

    scheduler.stop();
    expect(scheduler.isActive()).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(5000);
    expect(scheduler.getRunCount()).toBe(1);
  });
});
