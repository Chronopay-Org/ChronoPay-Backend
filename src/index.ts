import { loadEnvConfig } from "./config/env.js";
import { createApp } from "./app.js";
import { getFraudDriftDetector } from "./services/fraudDriftDetector.js";

const config = loadEnvConfig();
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
    console.log("[dispute-deadline] Scheduler disabled via DISPUTE_DEADLINE_DISABLED");
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

const PORT = config.port || 3001;
const server = app.listen(PORT, () => {
  console.log(`ChronoPay API listening on http://localhost:${PORT}`);
});

export default server;
