import { loadEnvConfig } from "./config/env.js";
import { createApp } from "./app.js";
import { getFraudDriftDetector } from "./services/fraudDriftDetector.js";
import { escrowMigrationState } from "./services/escrowMigrationState.js";
import { logger } from "./utils/logger.js";
import { ApplicationLifecycle, registerShutdownSignals } from "./lifecycle.js";
import { closePool } from "./db/connection.js";
import { closePool as closeLegacyPool } from "./db/pool.js";
import { closeRedisClient } from "./cache/redisClient.js";
import { stopScheduler } from "./scheduler/reminderScheduler.js";

const config = loadEnvConfig();
const lifecycle = new ApplicationLifecycle(
  [
    { name: "database", close: closePool },
    { name: "legacy-database", close: closeLegacyPool },
    { name: "redis", close: closeRedisClient },
  ],
  Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 30_000),
);
lifecycle.registerStop("reminders", stopScheduler);

// Validate pinned escrow contract hash on startup
const pinnedHash = escrowMigrationState.getPinnedHash();
if (pinnedHash) {
  if (!/^C[A-Z0-9]{55}$/.test(pinnedHash) && !/^[0-9a-fA-F]{64}$/.test(pinnedHash)) {
    logger.fatal({ pinnedHash }, "invalid escrow contract hash pin format");
    process.exit(1);
  }
  logger.info({ pinnedHash }, "escrow contract pinned to hash");
}

const app = createApp({
  requestTracker: lifecycle.trackRequests,
  enableDocs: true,
  enableTestRoutes: config.nodeEnv !== "production",
  apiKey: process.env.CHRONOPAY_API_KEY,
});

// Optional fraud score drift detector. Operators opt in via env so unit tests
// that exercise `createApp()` don't pull in the recurring check loop. When
// enabled, the detector runs `runDriftCheck()` every `FRAUD_DRIFT_INTERVAL_MS`
// (default 5m) and emits structured `FRAUD_DRIFT_ALARM` log lines on breach.
// See docs/fraud-drift.md for thresholds and runbook.
if (process.env.FRAUD_DRIFT_ENABLED === "true") {
  const detector = getFraudDriftDetector();
  const timer = detector.startDetector(Number(process.env.FRAUD_DRIFT_INTERVAL_MS) || undefined);
  lifecycle.registerStop("fraud-drift", () => detector.stopDetector(timer));
}

// ─── Dispute Deadline Scheduler ──────────────────────────────────────────────
// Auto-resolves disputes that have exceeded their inactivity / appeal / senior
// review windows. Enabled by default; set DISPUTE_DEADLINE_DISABLED=true to skip.
// The scheduler pulls the current dispute list from src/routes/admin.ts via a
// dynamic import to avoid circular deps at module load time.
(async () => {
  if (process.env.DISPUTE_DEADLINE_DISABLED === "true") {
    logger.info("dispute-deadline scheduler disabled via DISPUTE_DEADLINE_DISABLED");
    return;
  }

  const { startDisputeDeadlineScheduler, stopDisputeDeadlineScheduler } =
    await import("./scheduler/disputeDeadlineScheduler.js");

  // Dynamically import admin routes to get the disputes map.
  const { getDisputes } = await import("./routes/admin.js");

  if (lifecycle.isShuttingDown) return;
  lifecycle.registerStop("dispute-deadline", stopDisputeDeadlineScheduler);
  startDisputeDeadlineScheduler(getDisputes, {
    pollIntervalMs: Number(process.env.DISPUTE_DEADLINE_INTERVAL_MS) || undefined,
    inactivityTimeoutMs: Number(process.env.DISPUTE_INACTIVITY_TIMEOUT_MS) || undefined,
    seniorReviewTimeoutMs: Number(process.env.DISPUTE_SENIOR_REVIEW_TIMEOUT_MS) || undefined,
    autoResolveWindowMs: Number(process.env.DISPUTE_AUTO_RESOLVE_WINDOW_MS) || undefined,
  });
})();

// ─── Feature-Flag Rollout Scheduler (#570) ──────────────────────────────────
// Advances scheduled percentage rollouts (src/flags/rolloutScheduleRegistry.ts)
// to whatever step is due. Enabled by default; set
// FLAG_ROLLOUT_SCHEDULER_DISABLED=true to skip (e.g. in single-shot scripts).
(async () => {
  if (process.env.FLAG_ROLLOUT_SCHEDULER_DISABLED === "true") {
    logger.info("flag-rollout-scheduler disabled via FLAG_ROLLOUT_SCHEDULER_DISABLED");
    return;
  }

  const { createFlagRolloutScheduler } = await import("./scheduler/flagRolloutScheduler.js");
  if (lifecycle.isShuttingDown) return;
  const scheduler = createFlagRolloutScheduler({
    runIntervalMs: Number(process.env.FLAG_ROLLOUT_INTERVAL_MS) || undefined,
  });
  lifecycle.registerStop("flag-rollout", () => scheduler.stop());
  scheduler.start();
})();

// ─── Outbox Relay Worker ─────────────────────────────────────────────────────
// Polls the outbox_events table for un-acked events, publishes them via the
// configured callback, and marks them as acknowledged.  Guarantees at-least-once
// delivery.  Set OUTBOX_RELAY_DISABLED=true to skip.
// ─── Subscription Slot Generator Worker ────────────────────────────────────
// Idempotent background worker that auto-mints recurring slots for active
// subscriptions. Set SUBSCRIPTION_SLOT_GENERATOR_DISABLED=true to skip.
(async () => {
  if (process.env.SUBSCRIPTION_SLOT_GENERATOR_DISABLED === "true") {
    logger.info("subscription-slot-generator disabled via SUBSCRIPTION_SLOT_GENERATOR_DISABLED");
    return;
  }

  const { createSubscriptionSlotGenerator } = await import(
    "./scheduler/subscriptionSlotGenerator.js"
  );
  const { SubscriptionService } = await import("./services/subscriptionService.js");

  // In production, use SQL-backed repositories; here we use in-memory for the
  // standalone worker. The app.ts routes use their own repository instances.
  const { InMemorySubscriptionProductRepository } = await import(
    "./modules/subscriptions/subscription-product-repository.js"
  );
  const { InMemorySubscriptionRepository } = await import(
    "./modules/subscriptions/subscription-repository.js"
  );
  const { InMemorySlotRepository } = await import(
    "./modules/slots/slot-repository.js"
  );

  const productRepo = new InMemorySubscriptionProductRepository();
  const subscriptionRepo = new InMemorySubscriptionRepository();
  const slotRepo = new InMemorySlotRepository();
  const service = new SubscriptionService(productRepo, subscriptionRepo, slotRepo);

  const generator = createSubscriptionSlotGenerator(service, {
    intervalMs: Number(process.env.SUBSCRIPTION_SLOT_GENERATOR_INTERVAL_MS) || undefined,
    batchSize: Number(process.env.SUBSCRIPTION_SLOT_GENERATOR_BATCH_SIZE) || undefined,
  });
  if (lifecycle.isShuttingDown) return;
  lifecycle.registerStop("subscription-generator", () => generator.stop());
  generator.start();
  logger.info("subscription-slot-generator worker started");
})();

(async () => {
  if (process.env.OUTBOX_RELAY_DISABLED === "true") {
    logger.info("outbox-relay disabled via OUTBOX_RELAY_DISABLED");
    return;
  }

  const { runOutboxRelayWorker, SqlOutboxStore } = await import("./services/outboxRelay.js");
  const { getPool } = await import("./db/connection.js");

  if (lifecycle.isShuttingDown) return;
  const pool = getPool();
  const store = new SqlOutboxStore(pool);

  // Default publish callback: log the event (production deployments replace
  // this with a real publisher, e.g. Kafka producer or webhook dispatcher).
  const publish = async (event: {
    id: string;
    event_type: string;
    aggregate_id: string;
    payload: unknown;
  }) => {
    logger.info(
      { eventId: event.id, eventType: event.event_type, aggregateId: event.aggregate_id },
      "outbox relay: publishing event",
    );
  };

  const controller = new AbortController();
  const worker = runOutboxRelayWorker(controller.signal, store, publish).catch((err: Error) => {
    logger.error({ err }, "outbox relay worker exited unexpectedly");
  });
  lifecycle.registerStop("outbox-relay", async () => {
    controller.abort();
    await worker;
  });
  logger.info("outbox-relay worker started");
})();

// ─── Settlement Finality Reconciler (#804) ─────────────────────────────────
// Polls Horizon to verify on-chain finality for provider settlements before
// any payout is marked ready, and flags forks/reorgs. Enabled when Horizon
// URLs are configured; set SETTLEMENT_RECONCILER_DISABLED=true to skip.
(async () => {
  if (process.env.SETTLEMENT_RECONCILER_DISABLED === "true") {
    logger.info("settlement-reconciler disabled via SETTLEMENT_RECONCILER_DISABLED");
    return;
  }
  if (!config.horizonUrls || config.horizonUrls.length === 0) {
    logger.info("settlement-reconciler skipped: no HORIZON_URLS configured");
    return;
  }

  const { ContractService } = await import("./services/contract.service.js");
  const { HorizonContractClient } = await import("./clients/horizon-contract-client.js");
  const { startSettlementReconciler } = await import("./services/settlementReconciler.js");

  if (lifecycle.isShuttingDown) return;
  const contractService = new ContractService();
  const horizonClient = new HorizonContractClient(
    config.horizonUrls,
    config.networkPassphrase ?? "Test SDF Network ; September 2015",
    contractService,
  );

  const reconciler = startSettlementReconciler({
    horizonClient,
    pollIntervalMs: Number(process.env.SETTLEMENT_RECONCILER_POLL_INTERVAL_MS) || undefined,
    minConfirmations: Number(process.env.MIN_LEDGER_CONFIRMATIONS) || undefined,
  });
  lifecycle.registerStop("settlement-reconciler", () => reconciler.stop());

  logger.info("settlement-reconciler started");
})();

const PORT = config.port || 3001;

/**
 * Under test we must not bind a port: several suites import this module in the
 * same process, and the first `listen` would make every later import throw
 * EADDRINUSE. Tests drive the exported Express app through supertest instead.
 */
const isTestEnv = process.env.NODE_ENV === "test";
const server = isTestEnv
  ? undefined
  : app.listen(PORT, () => {
      logger.info({ port: PORT }, `ChronoPay API listening on http://localhost:${PORT}`);
    });

lifecycle.setServer(server);

export const trackRequests = lifecycle.trackRequests;
export const setServer = (server?: Parameters<ApplicationLifecycle["setServer"]>[0]): void =>
  lifecycle.setServer(server);
export const resetShutdownFlag = (): void => lifecycle.resetShutdownFlag();
export const gracefulShutdown = (): Promise<void> => lifecycle.shutdown();
export const getActiveRequestCount = (): number => lifecycle.getActiveRequestCount();

if (!isTestEnv) {
  registerShutdownSignals(gracefulShutdown, {
    timeoutMs: Math.min(lifecycle.timeoutMs + 1000, 2_147_483_647),
  });
}

export { app };
export default app;
