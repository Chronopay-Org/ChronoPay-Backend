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

const PORT = config.port || 3001;
const server = app.listen(PORT, () => {
  console.log(`ChronoPay API listening on http://localhost:${PORT}`);
});

export default server;
