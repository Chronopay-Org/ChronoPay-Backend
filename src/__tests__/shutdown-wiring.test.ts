import { afterAll, expect, it, jest } from "@jest/globals";
import express from "express";

const originalEnv = { ...process.env };
for (const key of [
  "DISPUTE_DEADLINE_DISABLED",
  "FLAG_ROLLOUT_SCHEDULER_DISABLED",
  "SUBSCRIPTION_SLOT_GENERATOR_DISABLED",
  "OUTBOX_RELAY_DISABLED",
  "SETTLEMENT_RECONCILER_DISABLED",
])
  delete process.env[key];
process.env.FRAUD_DRIFT_ENABLED = "true";
afterAll(() => {
  process.env = originalEnv;
});

const stopped: string[] = [];
const closed: string[] = [];
const started = new Set<string>();
let allStarted!: () => void;
const workersReady = new Promise<void>((resolve) => {
  allStarted = resolve;
});
function start(name: string) {
  started.add(name);
  if (started.size === 5) allStarted();
}
const stop = (name: string) => () => {
  stopped.push(name);
};
const close = (name: string) => async () => {
  closed.push(name);
};

// Mock external workers/drivers, not lifecycle or the entry point being tested.
jest.unstable_mockModule("../app.js", () => ({ createApp: () => express() }));
jest.unstable_mockModule("../config/env.js", () => ({
  loadEnvConfig: () => ({ nodeEnv: "test", horizonUrls: ["https://unused.invalid"] }),
}));
jest.unstable_mockModule("../services/escrowMigrationState.js", () => ({
  escrowMigrationState: { getPinnedHash: () => null },
}));
jest.unstable_mockModule("../db/connection.js", () => ({
  getPool: () => ({}),
  closePool: close("db"),
}));
jest.unstable_mockModule("../db/pool.js", () => ({ closePool: close("legacy-db") }));
jest.unstable_mockModule("../cache/redisClient.js", () => ({ closeRedisClient: close("redis") }));
jest.unstable_mockModule("../scheduler/reminderScheduler.js", () => ({
  stopScheduler: stop("reminders"),
}));
jest.unstable_mockModule("../services/fraudDriftDetector.js", () => ({
  getFraudDriftDetector: () => ({ startDetector: () => 1, stopDetector: stop("fraud") }),
}));
jest.unstable_mockModule("../routes/admin.js", () => ({ getDisputes: () => [] }));
jest.unstable_mockModule("../scheduler/disputeDeadlineScheduler.js", () => ({
  startDisputeDeadlineScheduler: () => start("disputes"),
  stopDisputeDeadlineScheduler: stop("disputes"),
}));
jest.unstable_mockModule("../scheduler/flagRolloutScheduler.js", () => ({
  createFlagRolloutScheduler: () => ({ start: () => start("flags"), stop: stop("flags") }),
}));
jest.unstable_mockModule("../scheduler/subscriptionSlotGenerator.js", () => ({
  createSubscriptionSlotGenerator: () => ({
    start: () => start("subscriptions"),
    stop: stop("subscriptions"),
  }),
}));
jest.unstable_mockModule("../services/subscriptionService.js", () => ({
  SubscriptionService: class {},
}));
jest.unstable_mockModule("../modules/subscriptions/subscription-product-repository.js", () => ({
  InMemorySubscriptionProductRepository: class {},
}));
jest.unstable_mockModule("../modules/subscriptions/subscription-repository.js", () => ({
  InMemorySubscriptionRepository: class {},
}));
jest.unstable_mockModule("../modules/slots/slot-repository.js", () => ({
  InMemorySlotRepository: class {},
}));
jest.unstable_mockModule("../services/outboxRelay.js", () => ({
  SqlOutboxStore: class {},
  runOutboxRelayWorker: (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      start("outbox");
      signal.addEventListener(
        "abort",
        () => {
          stopped.push("outbox");
          resolve();
        },
        { once: true },
      );
    }),
}));
jest.unstable_mockModule("../services/contract.service.js", () => ({ ContractService: class {} }));
jest.unstable_mockModule("../clients/horizon-contract-client.js", () => ({
  HorizonContractClient: class {},
}));
jest.unstable_mockModule("../services/settlementReconciler.js", () => ({
  startSettlementReconciler: () => {
    start("settlements");
    return { stop: stop("settlements") };
  },
}));

it("wires every enabled worker and both pools plus Redis into the real entry point", async () => {
  const { gracefulShutdown } = await import("../index.js");
  await workersReady;
  const pending = gracefulShutdown();
  expect(gracefulShutdown()).toBe(pending);
  await pending;
  expect(stopped.sort()).toEqual([
    "disputes",
    "flags",
    "fraud",
    "outbox",
    "reminders",
    "settlements",
    "subscriptions",
  ]);
  expect(closed.sort()).toEqual(["db", "legacy-db", "redis"]);
});
