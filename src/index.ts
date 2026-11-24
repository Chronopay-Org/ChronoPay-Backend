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
import { runRefundableHoldSweeper } from "./scheduler/refundableHoldSweeper.js";
import { sharedHoldRepository } from "./scheduler/refundableHoldContainer.js";
import { sharedSchedulingService } from "./services/schedulingContainer.js";

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

// ─── Recurrence Occurrence Materializer ──────────────────────────────────────
// Rolls active recurrence series forward to the configured horizon.
(async () => {
  if (process.env.OCCURRENCE_MATERIALIZER_DISABLED === "true") {
    logger.info("occurrence-materializer disabled via OCCURRENCE_MATERIALIZER_DISABLED");
    return;
  }

  const { createOccurrenceMaterializerScheduler } = await import(
    "./scheduler/occurrenceMaterializerScheduler.js"
  );
  if (lifecycle.isShuttingDown) return;

  const scheduler = createOccurrenceMaterializerScheduler({
    intervalMs: Number(process.env.OCCURRENCE_MATERIALIZER_INTERVAL_MS) || undefined,
    isShuttingDown: () => lifecycle.isShuttingDown,
  });
  lifecycle.registerStop("occurrence-materializer", () => scheduler.stop());
  scheduler.start();
})();

// Evaluates supplier tier alerts hourly when the alert service is enabled.
(async () => {
  if (process.env.TIER_ALERT_SCHEDULER_DISABLED === "true") {
    logger.info("tier-alert-scheduler disabled via TIER_ALERT_SCHEDULER_DISABLED");
    return;
  }

  const { defaultSupplierTierAlertService } = await import(
    "./services/supplierTierAlertService.js"
  );
  if (!defaultSupplierTierAlertService.isEnabled()) {
    logger.info("tier-alert-scheduler skipped: supplier tier alert service is disabled");
    return;
  }

  const { createTierAlertScheduler } = await import("./scheduler/tierAlertScheduler.js");
  if (lifecycle.isShuttingDown) return;
  const scheduler = createTierAlertScheduler({
    runIntervalMs: Number(process.env.TIER_ALERT_INTERVAL_MS) || undefined,
    onAlert: (alert) => {
      logger.warn(
        { supplierId: alert.supplierId, tier: alert.toTier },
        "supplier tier alert",
      );
    },
  });
  lifecycle.registerStop("tier-alert-scheduler", () => scheduler.stop());
  scheduler.start();
  logger.info("tier-alert-scheduler started");
})();

// Runs the SOC2 access-review worker; set ACCESS_REVIEW_WORKER_DISABLED=true to skip.
(async () => {
  if (process.env.ACCESS_REVIEW_WORKER_DISABLED === "true") {
    logger.info("access-review-worker disabled via ACCESS_REVIEW_WORKER_DISABLED");
    return;
  }

  const { startAccessReviewWorker, stopAccessReviewWorker } = await import(
    "./scheduler/accessReviewWorker.js"
  );
  if (lifecycle.isShuttingDown) return;
  lifecycle.registerStop("access-review", stopAccessReviewWorker);
  startAccessReviewWorker();
  logger.info("access-review-worker started");
})();

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
  // Test-only routes (/__test__/explode, /api/v1/test/auth) are available in
  // the automated test environment. Every other environment — staging and
  // production included — must opt in explicitly via ENABLE_TEST_ROUTES.
  enableTestRoutes: config.nodeEnv === "test" || config.enableTestRoutes,
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

  // Dynamically import the disputes router to get its in-memory state.
  const { getDisputes } = await import("./routes/adminDisputes.js");

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
  const { subscriptionService: service } = await import(
    "./services/subscriptionContainer.js"
  );

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

// ─── Hold Auto-Refund Worker (#1414) ─────────────────────────────────────────
// Polls for refundable holds whose holdUntilMs has elapsed and issues automatic
// refunds. Set HOLD_AUTO_REFUND_DISABLED=true to skip (e.g. for read-only
// replicas or single-shot scripts). Shares the process-wide booking-intent
// repository with the HTTP routes so worker-issued refunds are visible through
// the API immediately.
(async () => {
  if (process.env.HOLD_AUTO_REFUND_DISABLED === "true") {
    logger.info("hold-auto-refund worker disabled via HOLD_AUTO_REFUND_DISABLED");
    return;
  }

  const { createHoldAutoRefundWorker } = await import(
    "./scheduler/holdAutoRefundWorker.js"
  );
  const { bookingIntentContainer } = await import(
    "./modules/booking-intents/bookingIntentContainer.js"
// ─── Expiry Cleanup Worker (#1425) ──────────────────────────────────────────
// Expires stale pending booking intents and soft-expires / deletes checkout
// sessions whose TTL has passed.  Set EXPIRY_CLEANUP_DISABLED=true to skip.
(async () => {
  if (process.env.EXPIRY_CLEANUP_DISABLED === "true") {
    logger.info("expiry-cleanup-worker disabled via EXPIRY_CLEANUP_DISABLED");
    return;
  }

  const { runExpiryCleanupWorker } = await import("./scheduler/expiryCleanupWorker.js");
  const { InMemoryBookingIntentRepository } = await import(
    "./modules/booking-intents/booking-intent-repository.js"
  );
  const { InMemorySlotRepository } = await import("./modules/slots/slot-repository.js");
  const { BookingIntentService } = await import(
    "./modules/booking-intents/booking-intent-service.js"
  );

  if (lifecycle.isShuttingDown) return;

  const worker = createHoldAutoRefundWorker(
    {
      bookingIntentService: bookingIntentContainer.bookingIntentService,
      bookingIntentRepository: bookingIntentContainer.bookingIntentRepository,
    },
    {
      intervalMs: Number(process.env.HOLD_AUTO_REFUND_INTERVAL_MS) || undefined,
      batchSize: Number(process.env.HOLD_AUTO_REFUND_BATCH_SIZE) || undefined,
      safetyThreshold: Number(process.env.HOLD_AUTO_REFUND_SAFETY_THRESHOLD) || undefined,
    },
  );

  lifecycle.registerStop("hold-auto-refund", () => worker.stop());
  worker.start();
  logger.info("hold-auto-refund worker started");
  const bookingIntentRepository = new InMemoryBookingIntentRepository();
  const slotRepository = new InMemorySlotRepository();
  const bookingIntentService = new BookingIntentService(bookingIntentRepository, slotRepository);

  const controller = new AbortController();
  const worker = runExpiryCleanupWorker(controller.signal, {
    bookingIntentService,
    bookingIntentRepository,
  }).catch((err: Error) => {
    logger.error({ err }, "expiry-cleanup-worker exited unexpectedly");
  });

  lifecycle.registerStop("expiry-cleanup", async () => {
    controller.abort();
    await worker;
  });
  logger.info("expiry-cleanup-worker started");
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

// ─── Refundable Hold Sweeper (#1426) ─────────────────────────────────────────
// Periodically scans for expired refundable holds and releases slot capacity
// back to the marketplace.  Emits hold_released events that invalidate the
// search cache.  Set REFUNDABLE_HOLD_SWEEPER_DISABLED=true to skip.
if (process.env.REFUNDABLE_HOLD_SWEEPER_DISABLED === "true") {
  logger.info("refundable-hold-sweeper disabled via REFUNDABLE_HOLD_SWEEPER_DISABLED");
} else {
  const sweepIntervalMs = Number(process.env.REFUNDABLE_HOLD_SWEEPER_INTERVAL_MS) || undefined;
  const sweepController = new AbortController();
  const sweepWorker = runRefundableHoldSweeper(
    sweepController.signal,
    { holdRepository: sharedHoldRepository, schedulingService: sharedSchedulingService },
    { intervalMs: sweepIntervalMs },
  ).catch((err: Error) => {
    logger.error({ err }, "refundable-hold-sweeper exited unexpectedly");
  });
  lifecycle.registerStop("refundable-hold-sweeper", async () => {
    sweepController.abort();
    await sweepWorker;
  });
  logger.info(
    { intervalMs: sweepIntervalMs ?? 5_000 },
    "refundable-hold-sweeper started",
  );
}
// ─── Timezone Drift Monitor (#1427) ─────────────────────────────────────────
// Scans real slots (shared process-wide slot repository) for ambiguous or
// missing timezone data and updates the tzDrift* gauges. Set
// TZ_DRIFT_MONITOR_DISABLED=true to skip.
(async () => {
  if (process.env.TZ_DRIFT_MONITOR_DISABLED === "true") {
    logger.info("tz-drift-monitor disabled via TZ_DRIFT_MONITOR_DISABLED");
    return;
  }

  const { startTzDriftMonitor } = await import("./scheduler/tzDriftMonitorWiring.js");
  const { slotRepository } = await import("./modules/booking-intents/bookingIntentContainer.js");

  if (lifecycle.isShuttingDown) return;
  startTzDriftMonitor(lifecycle, slotRepository);
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
