// @ts-nocheck
/**
 * fraudDriftDetector.ts
 * ----------------------
 * Detects statistical drift between live fraud score distributions and a
 * frozen training baseline. Computes PSI and KL divergence at scheduled
 * intervals; emits a structured alarm log when thresholds are breached.
 *
 * Operations
 * ----------
 * - `recordFraudScore(modelVersion, score)`   – feed one score observation
 * - `setFraudScoreBaseline(modelVersion, h)`  – freeze training distribution
 * - `clearBaselineForVersion(modelVersion)`   – drop a baseline
 * - `runDriftCheck(opts?)`                    – compute drift now and emit
 * - `startDetector(opts?)` / `stopDetector()` – interval-driven periodic run
 *
 * Alarms
 * ------
 * Alarms do NOT page an external system. They:
 *   1. Emit a `logger.error` with a stable `code: "FRAUD_DRIFT_ALARM"` field
 *      and a `runbook` URL so downstream log-based pagers can route.
 *   2. Increment the counter `fraud_drift_alerts_total` with bounded labels.
 *   3. Update the gauge `fraud_drift_status` so dashboards can show the
 *      last-seen severity without logs.
 *
 * Flap guard
 * ----------
 * To avoid alert fatigue when a model hangs tightly around a threshold,
 * the detector suppresses repeated alarms for the same (modelVersion,
 * severity, statistic) tuple within `flapCooldownMs`. Thevery first alarm
 * after a model swap or threshold ESCALATION is always emitted.
 */

import {
  combinedSeverity,
  DEFAULT_EPSILON,
  DEFAULT_THRESHOLDS,
  type DriftSeverity,
  type DriftThresholds,
  emptyHistogram,
  kullbackLeiblerDivergence,
  normalizeToDistribution,
  populationStabilityIndex,
  
} from "./fraudDriftMath.js";
import {
  clearBaseline,
  clearFraudDriftState,
  getFraudDriftSnapshot,
  recordFraudScore,
  setFraudScoreBaseline,
} from "../metrics/fraudDriftMetrics.js";
import {
  createBudgetedCounter,
  createBudgetedGauge,
} from "../metrics.js";
import { logger } from "../utils/logger.js";

/* ─── Singleton Prometheus metrics (bounded labels, no PII) ─────────────── */

export const fraudDriftPsiGauge = createBudgetedGauge({
  name: "fraud_drift_psi",
  help: "Population Stability Index between baseline and live fraud score distributions",
  labels: ["model_version"],
  budget: 8,
});

export const fraudDriftKlGauge = createBudgetedGauge({
  name: "fraud_drift_kl",
  help: "Kullback-Leibler divergence between baseline and live fraud score distributions",
  labels: ["model_version"],
  budget: 8,
});

export const fraudDriftStatusGauge = createBudgetedGauge({
  name: "fraud_drift_status",
  help: "Most recent drift severity per model version: 0=ok, 1=warning, 2=critical, 3=no_baseline",
  labels: ["model_version"],
  budget: 8,
});

export const fraudDriftAlertsCounter = createBudgetedCounter({
  name: "fraud_drift_alerts_total",
  help: "Total number of fraud drift alarms emitted, broken down by severity and statistic",
  labels: ["model_version", "severity", "statistic"],
  budget: 64, // 8 versions * 4 (2 severity * 2 statistic)
});

const STATUS_OK = 0;
const STATUS_WARNING = 1;
const STATUS_CRITICAL = 2;
const STATUS_NO_BASELINE = 3;

const SEVERITY_TO_STATUS: Record<DriftSeverity, number> = {
  ok: STATUS_OK,
  warning: STATUS_WARNING,
  critical: STATUS_CRITICAL,
};

export type DriftStatisticName = "psi" | "kl";

export interface DriftCheckOptions {
  /** Override the default thresholds for this run (e.g. tests). */
  thresholds?: Partial<DriftThresholds>;
  /** Override smoothing epsilon. */
  epsilon?: number;
  /** Live minimum sample size; below this, status = no_baseline (warning). */
  minLiveSamples?: number;
  /** Override clock for tests. */
  now?: number;
  /** Emitter override (for tests): receives the alarm payload instead of logging. */
  emit?: (payload: FraudDriftAlarm) => void;
}

export interface ModelDriftResult {
  modelVersion: string;
  psi: number;
  kl: number;
  severity: DriftSeverity;
  /** True when no comparison could be performed (no baseline, too few samples, …). */
  skipped: boolean;
  skipReason?: "no_baseline" | "insufficient_samples" | "empty_both";
  statistics: { psi: { value: number; severity: DriftSeverity }; kl: { value: number; severity: DriftSeverity } };
}

export interface DriftReport {
  results: ModelDriftResult[];
  /** True if any model is currently in critical or warning. */
  anyBreach: boolean;
  /** Snapshot timestamp (ms). */
  now: number;
}

export interface FraudDriftAlarm {
  code: "FRAUD_DRIFT_ALARM";
  modelVersion: string;
  severity: DriftSeverity;
  statistic: DriftStatisticName;
  value: number;
  threshold: number;
  liveSamples: number;
  baselineSamples: number;
  runbook: string;
  observedAt: string;
}

const DEFAULT_RUNBOOK_URL =
  process.env.FRAUD_DRIFT_RUNBOOK_URL ||
  "https://runbooks.chronopay.local/fraud/drift-detector";

const DEFAULT_FLAP_COOLDOWN_MS =
  Number(process.env.FRAUD_DRIFT_FLAP_COOLDOWN_MS) || 30 * 60 * 1000; // 30 min

export const DEFAULT_INTERVAL_MS = Number(process.env.FRAUD_DRIFT_INTERVAL_MS) || 5 * 60 * 1000; // 5 min

/** Floor on `startDetector(intervalMs)` to keep `setInterval` from spinning. */
export const MIN_DETECTOR_INTERVAL_MS = 1_000;

const DEFAULT_MIN_LIVE_SAMPLES = Number(process.env.FRAUD_DRIFT_MIN_SAMPLES) || 50;

interface AlarmCacheEntry {
  at: number;
}

const _alarmCache = new Map<string, AlarmCacheEntry>();

function cacheKey(modelVersion: string, severity: DriftSeverity, statistic: DriftStatisticName): string {
  return `${modelVersion}|${severity}|${statistic}`;
}

function withinFlapCooldown(
  modelVersion: string,
  severity: DriftSeverity,
  statistic: DriftStatisticName,
  now: number,
  cooldownMs: number,
): boolean {
  if (cooldownMs <= 0) return false;
  if (severity === "ok") return false; // never suppress ok-transition events
  const key = cacheKey(modelVersion, severity, statistic);
  const entry = _alarmCache.get(key);
  if (!entry) return false;
  return now - entry.at < cooldownMs;
}

function recordEmission(
  modelVersion: string,
  severity: DriftSeverity,
  statistic: DriftStatisticName,
  now: number,
): void {
  _alarmCache.set(cacheKey(modelVersion, severity, statistic), { at: now });
}

export interface FraudDriftDetectorOptions {
  thresholds?: Partial<DriftThresholds>;
  epsilon?: number;
  flapCooldownMs?: number;
  minLiveSamples?: number;
  runbookUrl?: string;
  emit?: (payload: FraudDriftAlarm) => void;
}

export class FraudDriftDetector {
  private readonly thresholds: DriftThresholds;
  private readonly epsilon: number;
  private readonly flapCooldownMs: number;
  private readonly minLiveSamples: number;
  private readonly runbookUrl: string;
  private readonly emit: (payload: FraudDriftAlarm) => void;

  constructor(opts: FraudDriftDetectorOptions = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
    this.epsilon = opts.epsilon ?? DEFAULT_EPSILON;
    this.flapCooldownMs = opts.flapCooldownMs ?? DEFAULT_FLAP_COOLDOWN_MS;
    this.minLiveSamples = opts.minLiveSamples ?? DEFAULT_MIN_LIVE_SAMPLES;
    this.runbookUrl = opts.runbookUrl ?? DEFAULT_RUNBOOK_URL;
    this.emit = opts.emit ?? defaultEmit;
  }

  /** Convenience: feed one score. Delegates to metrics module. */
  recordScore(modelVersion: string, score: number): void {
    recordFraudScore(modelVersion, score);
  }

  /** Convenience: replace baseline histogram. */
  setBaseline(modelVersion: string, histogram: Record<string, number>): void {
    setFraudScoreBaseline(modelVersion, histogram);
  }

  /** Convenience: drop baseline for one version (e.g. after retraining). */
  clearBaselineForVersion(modelVersion: string): void {
    clearBaseline(modelVersion);
  }

  /** Convenience: drop all state for one version (model swap). */
  resetForVersion(modelVersion: string): void {
    clearFraudDriftState(modelVersion);
  }

  /**
   * Run a single drift check across every tracked model version.
   *
   * @returns a {@link DriftReport} with per-version results.
   */
  runDriftCheck(opts: DriftCheckOptions = {}): DriftReport {
    const now = opts.now ?? Date.now();
    const epsilon = opts.epsilon ?? this.epsilon;
    const thresholds: DriftThresholds = { ...this.thresholds, ...opts.thresholds };
    const minSamples = opts.minLiveSamples ?? this.minLiveSamples;
    const emit = opts.emit ?? this.emit;

    const snap = getFraudDriftSnapshot();
    const results: ModelDriftResult[] = [];
    let anyBreach = false;

    for (const version of snap.versions) {
      const live = snap.live[version] ?? emptyHistogram();
      const baseline = snap.baseline[version] ?? emptyHistogram();
      const liveSamples = snap.liveTotals[version] ?? 0;
      const baselineSamples = snap.baselineTotals[version] ?? 0;

      const liveNorm = normalizeToDistribution(live, epsilon);
      const baselineNorm = normalizeToDistribution(baseline, epsilon);

      let result: ModelDriftResult;

      if (!baselineNorm || baselineSamples === 0) {
        result = {
          modelVersion: version,
          psi: NaN,
          kl: NaN,
          severity: "ok", // skipped; no breach emitted
          skipped: true,
          skipReason: "no_baseline",
          statistics: {
            psi: { value: NaN, severity: "ok" },
            kl: { value: NaN, severity: "ok" },
          },
        };
        fraudDriftStatusGauge.labels(version).set(STATUS_NO_BASELINE);
        results.push(result);
        continue;
      }

      if (!liveNorm || liveSamples < minSamples) {
        result = {
          modelVersion: version,
          psi: NaN,
          kl: NaN,
          severity: "ok",
          skipped: true,
          skipReason: "insufficient_samples",
          statistics: {
            psi: { value: NaN, severity: "ok" },
            kl: { value: NaN, severity: "ok" },
          },
        };
        fraudDriftStatusGauge.labels(version).set(STATUS_NO_BASELINE);
        results.push(result);
        continue;
      }

      const psi = populationStabilityIndex(baselineNorm, liveNorm);
      const kl = kullbackLeiblerDivergence(baselineNorm, liveNorm);
      const psiSev =
        !Number.isFinite(psi)
          ? "ok"
          : psi >= thresholds.psiCritical
            ? "critical"
            : psi >= thresholds.psiWarning
              ? "warning"
              : "ok";
      const klSev =
        !Number.isFinite(kl)
          ? "ok"
          : kl >= thresholds.klCritical
            ? "critical"
            : kl >= thresholds.klWarning
              ? "warning"
              : "ok";
      const severity = combinedSeverity(
        { value: psi, severity: psiSev },
        { value: kl, severity: klSev },
      );
      if (severity !== "ok") anyBreach = true;

      fraudDriftPsiGauge.labels(version).set(Number.isFinite(psi) ? psi : 0);
      fraudDriftKlGauge.labels(version).set(Number.isFinite(kl) ? kl : 0);
      fraudDriftStatusGauge.labels(version).set(SEVERITY_TO_STATUS[severity]);

      result = {
        modelVersion: version,
        psi,
        kl,
        severity,
        skipped: false,
        statistics: {
          psi: { value: psi, severity: psiSev },
          kl: { value: kl, severity: klSev },
        },
      };
      results.push(result);

      // Emit alarms per statistic so paging tools can route on which signal fired.
      maybeEmit({
        modelVersion: version,
        metric: { value: psi, severity: psiSev },
        liveSamples,
        baselineSamples,
        now,
        runbookUrl: this.runbookUrl,
        cooldownMs: this.flapCooldownMs,
        statistic: "psi",
        thresholdField: { warning: thresholds.psiWarning, critical: thresholds.psiCritical },
        emit,
      });
      maybeEmit({
        modelVersion: version,
        metric: { value: kl, severity: klSev },
        liveSamples,
        baselineSamples,
        now,
        runbookUrl: this.runbookUrl,
        cooldownMs: this.flapCooldownMs,
        statistic: "kl",
        thresholdField: { warning: thresholds.klWarning, critical: thresholds.klCritical },
        emit,
      });
    }

    return { results, anyBreach, now };
  }

  /**
   * Start the periodic detector. Returns the interval timer for later shutdown.
   *
   * The interval is clamped to {@link MIN_DETECTOR_INTERVAL_MS} (1s) so a
   * misconfigured deployment cannot forward a sub-second or negative value
   * to `setInterval` and saturate the event loop. Non-finite inputs (NaN,
   * ±Infinity) fall back to {@link DEFAULT_INTERVAL_MS} since they cannot
   * be safely clamped to a meaningful value.
   */
  startDetector(intervalMs: number = DEFAULT_INTERVAL_MS): NodeJS.Timeout {
    if (typeof setInterval === "undefined") {
      throw new Error("setInterval is unavailable in the current runtime");
    }
    const requested = Number(intervalMs);
    const safeInterval = Number.isFinite(requested)
      ? Math.max(MIN_DETECTOR_INTERVAL_MS, requested)
      : DEFAULT_INTERVAL_MS;
    return setInterval(() => {
      try {
        this.runDriftCheck();
      } catch (err) {
        logger.error({ err, code: "FRAUD_DRIFT_CHECK_FAILED" }, "fraud drift check threw");
      }
    }, safeInterval);
  }

  /**
   * Stop the periodic detector started by {@link startDetector}. Idempotent.
   * Mirrors `startDetector` as an instance method so the detector owns its
   * own lifecycle (`const timer = d.startDetector(); d.stopDetector(timer);`).
   */
  stopDetector(timer: NodeJS.Timeout | null | undefined): void {
    if (!timer) return;
    if (typeof clearInterval === "undefined") return;
    clearInterval(timer);
  }
}

interface MaybeEmitArgs {
  modelVersion: string;
  metric: { value: number; severity: DriftSeverity };
  liveSamples: number;
  baselineSamples: number;
  now: number;
  runbookUrl: string;
  cooldownMs: number;
  statistic: DriftStatisticName;
  thresholdField: { warning: number; critical: number };
  emit: (payload: FraudDriftAlarm) => void;
}

function maybeEmit(args: MaybeEmitArgs): void {
  const { modelVersion, metric, statistic, thresholdField, liveSamples, baselineSamples, now, runbookUrl, cooldownMs, emit } = args;
  if (metric.severity === "ok") return;
  if (withinFlapCooldown(modelVersion, metric.severity, statistic, now, cooldownMs)) {
    return;
  }
  const payload: FraudDriftAlarm = {
    code: "FRAUD_DRIFT_ALARM",
    modelVersion,
    severity: metric.severity,
    statistic,
    value: metric.value,
    threshold: metric.severity === "critical" ? thresholdField.critical : thresholdField.warning,
    liveSamples,
    baselineSamples,
    runbook: runbookUrl,
    observedAt: new Date(now).toISOString(),
  };
  emit(payload);
  fraudDriftAlertsCounter.labels(modelVersion, metric.severity, statistic).inc();
  recordEmission(modelVersion, metric.severity, statistic, now);
}

function defaultEmit(payload: FraudDriftAlarm): void {
  // Stable shape for downstream log-routing tools. Use error level for both
  // warning and critical so the alarm is picked up by error-based pages;
  // downstream tools demote by inspecting `severity`.
  logger.error(payload, `fraud drift alarm: ${payload.statistic} ${payload.severity}`);
}

// ─── Module-level singleton for ergonomic use ─────────────────────────────

let _singleton: FraudDriftDetector | null = null;

export function getFraudDriftDetector(opts?: FraudDriftDetectorOptions): FraudDriftDetector {
  if (!_singleton) _singleton = new FraudDriftDetector(opts);
  return _singleton;
}

/** Reset the module-level singleton — test isolation only. */
export function resetFraudDriftSingleton(): void {
  _singleton = null;
  _alarmCache.clear();
}
