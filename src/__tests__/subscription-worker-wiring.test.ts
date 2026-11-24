import { afterAll, expect, it, jest } from "@jest/globals";
import express from "express";
import { subscriptionService } from "../routes/subscriptions.js";
import type { SubscriptionService, GenerateSlotsResult } from "../services/subscriptionService.js";

const originalEnv = { ...process.env };
for (const key of [
  "DISPUTE_DEADLINE_DISABLED",
  "FLAG_ROLLOUT_SCHEDULER_DISABLED",
  "OUTBOX_RELAY_DISABLED",
  "SETTLEMENT_RECONCILER_DISABLED",
]) {
  process.env[key] = "true";
}
delete process.env.SUBSCRIPTION_SLOT_GENERATOR_DISABLED;
delete process.env.FRAUD_DRIFT_ENABLED;
afterAll(() => {
  process.env = originalEnv;
  jest.restoreAllMocks();
});

let started!: (value: { service: SubscriptionService; result: GenerateSlotsResult }) => void;
const ready = new Promise<{ service: SubscriptionService; result: GenerateSlotsResult }>(
  (resolve) => {
    started = resolve;
  },
);
jest.unstable_mockModule("../app.js", () => ({ createApp: () => express() }));
jest.unstable_mockModule("../services/escrowMigrationState.js", () => ({
  escrowMigrationState: { getPinnedHash: () => null },
}));
// Intercept scheduling only; subscription services and repositories stay real.
jest.unstable_mockModule("../scheduler/subscriptionSlotGenerator.js", () => ({
  createSubscriptionSlotGenerator: (service: SubscriptionService) => ({
    start: () => started({ service, result: service.generateSlotsForDueSubscriptions(Date.now()) }),
    stop: () => {},
  }),
}));

it("the real entry point generates for the router's subscription and updates its visible cursor", async () => {
  const product = subscriptionService.createProduct({
    name: "Shared worker",
    professional: "wiring-professional",
    slotDurationMs: 3600000,
    recurrenceRule: "FREQ=DAILY",
  });
  const sub = subscriptionService.subscribe({
    productId: product.id,
    subscriberId: "wiring-subscriber",
  });
  jest.spyOn(Date, "now").mockReturnValue(sub.nextSlotStartMs);
  await import("../index.js");
  const { result, service } = await ready;
  expect(result.minted).toHaveLength(1);
  expect(service).toBe(subscriptionService);
  expect(result.minted[0].subscriptionId).toBe(sub.id);
  expect(subscriptionService.getSubscription(sub.id).slotsMinted).toBe(1);
});
