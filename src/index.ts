import { loadEnvConfig } from "./config/env.js";
import { createApp } from "./app.js";
import { getFraudDriftDetector } from "./services/fraudDriftDetector.js";
import { escrowMigrationState } from "./services/escrowMigrationState.js";
import { logger } from "./utils/logger.js";

const config = loadEnvConfig();

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
  enableDocs: true,
  enableTestRoutes: config.nodeEnv !== "production",
});

// Optional fraud score drift detector. Operators opt in via env so unit tests
// that exercise `createApp()` don't pull in the recurring check loop. When
// enabled, the detector runs `runDriftCheck()` every `FRAUD_DRIFT_INTERVAL_MS`
// (default 5m) and emits structured `FRAUD_DRIFT_ALARM` log lines on breach.
// See docs/fraud-drift.md for thresholds and runbook.
if (process.env.FRAUD_DRIFT_ENABLED === "true") {
  getFraudDriftDetector().startDetector(
    Number(process.env.FRAUD_DRIFT_INTERVAL_MS) || undefined,
  );
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

  const { startDisputeDeadlineScheduler } = await import(
    "./scheduler/disputeDeadlineScheduler.js"
  );

  // Dynamically import admin routes to get the disputes map.
  const { getDisputes } = await import("./routes/admin.js");

  startDisputeDeadlineScheduler(
    getDisputes,
    {
      pollIntervalMs:
        Number(process.env.DISPUTE_DEADLINE_INTERVAL_MS) || undefined,
      inactivityTimeoutMs:
        Number(process.env.DISPUTE_INACTIVITY_TIMEOUT_MS) || undefined,
      seniorReviewTimeoutMs:
        Number(process.env.DISPUTE_SENIOR_REVIEW_TIMEOUT_MS) || undefined,
      autoResolveWindowMs:
        Number(process.env.DISPUTE_AUTO_RESOLVE_WINDOW_MS) || undefined,
    },
  );
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

  const { createFlagRolloutScheduler } = await import(
    "./scheduler/flagRolloutScheduler.js"
  );
  createFlagRolloutScheduler({
    runIntervalMs: Number(process.env.FLAG_ROLLOUT_INTERVAL_MS) || undefined,
  }).start();
})();

// ─── Outbox Relay Worker ─────────────────────────────────────────────────────
// Polls the outbox_events table for un-acked events, publishes them via the
// configured callback, and marks them as acknowledged.  Guarantees at-least-once
// delivery.  Set OUTBOX_RELAY_DISABLED=true to skip.
const _shutdownHooks: Array<() => void> = [];
(async () => {
  if (process.env.OUTBOX_RELAY_DISABLED === "true") {
    logger.info("outbox-relay disabled via OUTBOX_RELAY_DISABLED");
    return;
  }

  const { runOutboxRelayWorker, SqlOutboxStore } = await import(
    "./services/outboxRelay.js"
  );
  const { getPool } = await import("./db/connection.js");
  const { logger } = await import("./utils/logger.js");

  const pool = getPool();
  const store = new SqlOutboxStore(pool);

  const { dispatchSupplierWebhook } = await import("./services/supplierWebhookDispatcher.js");

  const publish = async (event: { id: string; event_type: string; aggregate_id: string; payload: unknown }) => {
    if (event.event_type === "slot.reservation.expired") {
      await dispatchSupplierWebhook(pool, event as any);
      return;
    }
    logger.info(
      { eventId: event.id, eventType: event.event_type, aggregateId: event.aggregate_id },
      "outbox relay: publishing event",
    );
  };

  const controller = new AbortController();
  _shutdownHooks.push(() => controller.abort());

  runOutboxRelayWorker(controller.signal, store, publish).catch((err: Error) => {
    logger.error({ err }, "outbox relay worker exited unexpectedly");
  });

  logger.info("outbox-relay worker started");
})();

const PORT = config.port || 3001;
const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, `ChronoPay API listening on http://localhost:${PORT}`);
});

let _serverInstance: any = server;
let _isShuttingDown = false;

export function setServer(srv: any): void {
  _serverInstance = srv;
}

export function resetShutdownFlag(): void {
  _isShuttingDown = false;
}

export async function gracefulShutdown(): Promise<void> {
  if (_isShuttingDown) return;
  _isShuttingDown = true;

  // Abort all background workers first
  for (const hook of _shutdownHooks) {
    try { hook(); } catch { /* ignore */ }
  }

  if (_serverInstance) {
    await new Promise<void>((resolve) => {
      try {
        _serverInstance.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
}

export function getActiveRequestCount(): number { return 0; }

export default server;
