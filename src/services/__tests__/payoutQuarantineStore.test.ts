// @ts-nocheck
import { EventEmitter } from "node:events";
import {
  PayoutQuarantineService,
  payoutQuarantineEvents,
  resetPayoutQuarantineState,
} from "../quarantineStore.js";

describe("PayoutQuarantineService", () => {
  beforeEach(() => {
    resetPayoutQuarantineState();
  });

  it("quarantines a payout after the configured failure threshold and emits an alert", async () => {
    const alerts: Array<Record<string, unknown>> = [];
    const listener = (payload: Record<string, unknown>) => alerts.push(payload);
    payoutQuarantineEvents.on("alert", listener as EventEmitter.ListenerFn);

    try {
      const service = new PayoutQuarantineService({ defaultThreshold: 2 });

      const first = await service.recordFailure({
        payoutId: "tx-999",
        supplierId: "supplier-a",
        errorClass: "NETWORK",
        errorMessage: "timeout",
      });
      expect(first.quarantined).toBe(false);
      expect(first.totalFailures).toBe(1);

      const second = await service.recordFailure({
        payoutId: "tx-999",
        supplierId: "supplier-a",
        errorClass: "NETWORK",
        errorMessage: "timeout",
      });
      expect(second.quarantined).toBe(true);
      expect(second.totalFailures).toBe(2);
      await expect(service.isQuarantined("tx-999")).resolves.toBe(true);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ payoutId: "tx-999", quarantineReason: "failure-threshold-reached" });
    } finally {
      payoutQuarantineEvents.off("alert", listener as EventEmitter.ListenerFn);
    }
  });

  it("releases a quarantined payout and allows it to be retried from a clean state", async () => {
    const service = new PayoutQuarantineService({ defaultThreshold: 2 });

    const first = await service.recordFailure({
      payoutId: "tx-100",
      supplierId: "supplier-b",
      errorClass: "VALIDATION",
      errorMessage: "missing amount",
    });
    expect(first.quarantined).toBe(false);

    const released = await service.release("tx-100", {
      releasedBy: "admin-1",
      reason: "Investigated",
    });
    expect(released).toBe(true);
    await expect(service.isQuarantined("tx-100")).resolves.toBe(false);

    const retried = await service.recordFailure({
      payoutId: "tx-100",
      supplierId: "supplier-b",
      errorClass: "VALIDATION",
      errorMessage: "missing amount",
    });
    expect(retried.quarantined).toBe(false);
    expect(retried.totalFailures).toBe(1);
  });

  it("emits only one alert when concurrent failures cross the threshold", async () => {
    const alerts: Array<Record<string, unknown>> = [];
    const listener = (payload: Record<string, unknown>) => alerts.push(payload);
    payoutQuarantineEvents.on("alert", listener as EventEmitter.ListenerFn);

    try {
      const service = new PayoutQuarantineService({ defaultThreshold: 3 });
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          service.recordFailure({ payoutId: "tx-concurrent" }),
        ),
      );

      expect(results.filter((result) => result.quarantined)).toHaveLength(1);
      expect(alerts).toHaveLength(1);
      await expect(service.get("tx-concurrent")).resolves.toMatchObject({
        totalFailures: 10,
        status: "quarantined",
      });
    } finally {
      payoutQuarantineEvents.off("alert", listener as EventEmitter.ListenerFn);
    }
  });
});
