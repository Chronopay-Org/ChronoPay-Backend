import { jest } from "@jest/globals";
import {
  FraudDriftDetector,
  resetFraudDriftSingleton,
  DEFAULT_INTERVAL_MS,
  MIN_DETECTOR_INTERVAL_MS,
  type FraudDriftAlarm,
} from "../fraudDriftDetector.js";
import {
  resetFraudDriftState,
  setFraudScoreBaseline,
  recordFraudScore,
} from "../../metrics/fraudDriftMetrics.js";
import {
  _resetMetricCardinalityState,
  register,
} from "../../metrics.js";

function buildHistogram(weights: Record<string, number>): Record<string, number> {
  return weights;
}

function feedLive(version: string, n: number, factory: (i: number) => number): void {
  for (let i = 0; i < n; i++) recordFraudScore(version, factory(i));
}

describe("FraudDriftDetector", () => {
  beforeEach(() => {
    resetFraudDriftState();
    resetFraudDriftSingleton();
    // Reset global Prometheus metrics + cardinality state so tests don't
    // observe stale gauge values from previous runs.
    register.resetMetrics();
    _resetMetricCardinalityState();
  });

  it("returns skipped result when no baseline is configured", () => {
    const detector = new FraudDriftDetector({ minLiveSamples: 5 });
    feedLive("v1", 50, () => 0);
    const report = detector.runDriftCheck({ now: 1_000_000 });
    expect(report.results).toHaveLength(1);
    expect(report.results[0].skipped).toBe(true);
    expect(report.results[0].skipReason).toBe("no_baseline");
    expect(report.anyBreach).toBe(false);
  });

  it("returns skipped when live samples are below the configured minimum", () => {
    const detector = new FraudDriftDetector({ minLiveSamples: 100 });
    setFraudScoreBaseline("v1", buildHistogram({ "0": 100, "1": 50 }));
    feedLive("v1", 10, () => 0);
    const report = detector.runDriftCheck({ now: 1 });
    expect(report.results[0].skipReason).toBe("insufficient_samples");
    expect(report.results[0].skipped).toBe(true);
  });

  it("reports ok when live matches baseline", () => {
    const detector = new FraudDriftDetector({ minLiveSamples: 50, flapCooldownMs: 0 });
    setFraudScoreBaseline("v1", buildHistogram({ "0": 100, "1": 50 }));
    // Live matches baseline proportions: 2/3 in bin "0", 1/3 in bin "1".
    feedLive("v1", 150, (i) => (i % 3 === 0 ? 1 : 0));
    const report = detector.runDriftCheck({ now: 100 });
    expect(report.results[0].severity).toBe("ok");
    expect(report.results[0].skipped).toBe(false);
    expect(report.anyBreach).toBe(false);
  });

  it("reports warning when a modest shift occurs", () => {
    const detector = new FraudDriftDetector({ minLiveSamples: 50, flapCooldownMs: 0 });
    // Baseline: 17% in bin "1". Live: ~33% in bin "1" — a clear distributional
    // shift that crosses the default PSI warning threshold but stays below
    // critical. PSI ≈ 0.15–0.18 under default thresholds.
    setFraudScoreBaseline("v1", buildHistogram({ "0": 1000, "1": 200 }));
    feedLive("v1", 1200, (i) => (i % 3 === 0 ? 1 : 0));
    const report = detector.runDriftCheck({ now: 200 });
    expect(report.results[0].severity).not.toBe("ok");
    expect(report.anyBreach).toBe(true);
  });

  it("reports critical when distributions are sharply different", () => {
    const detector = new FraudDriftDetector({
      minLiveSamples: 50,
      flapCooldownMs: 0,
      thresholds: { psiWarning: 0.1, psiCritical: 0.2, klWarning: 0.05, klCritical: 0.1 },
    });
    setFraudScoreBaseline("v1", buildHistogram({ "0": 800, "1": 200 }));
    feedLive("v1", 1000, () => 1); // all scores are 1 now
    const report = detector.runDriftCheck({ now: 300 });
    expect(report.results[0].severity).toBe("critical");
    expect(report.anyBreach).toBe(true);
  });

  it("emits alarms via custom emitter with correct payload", () => {
    const emitted: FraudDriftAlarm[] = [];
    const detector = new FraudDriftDetector({
      minLiveSamples: 50,
      flapCooldownMs: 0,
      emit: (p) => emitted.push(p),
      thresholds: { psiWarning: 0.1, psiCritical: 0.2, klWarning: 0.05, klCritical: 0.1 },
    });
    setFraudScoreBaseline("v1", buildHistogram({ "0": 800, "1": 200 }));
    feedLive("v1", 1000, () => 1);
    detector.runDriftCheck({ now: 400 });
    expect(emitted.length).toBeGreaterThan(0);
    for (const p of emitted) {
      expect(p.code).toBe("FRAUD_DRIFT_ALARM");
      expect(p.modelVersion).toBe("v1");
      expect(p.severity).toBe("critical");
      expect(p.statistic).toMatch(/^psi|kl$/);
      expect(p.runbook).toMatch(/^https?:\/\//);
      expect(p.observedAt).toBe(new Date(400).toISOString());
    }
    // At least one PSI-critical alarm and at least one KL-critical.
    expect(emitted.some((p) => p.statistic === "psi" && p.severity === "critical")).toBe(true);
    expect(emitted.some((p) => p.statistic === "kl" && p.severity === "critical")).toBe(true);
  });

  it("suppresses repeat alarms within the flap cooldown window", () => {
    const emitted: FraudDriftAlarm[] = [];
    const detector = new FraudDriftDetector({
      minLiveSamples: 50,
      flapCooldownMs: 60_000,
      emit: (p) => emitted.push(p),
      thresholds: { psiWarning: 0.1, psiCritical: 0.2, klWarning: 0.05, klCritical: 0.1 },
    });
    setFraudScoreBaseline("v1", buildHistogram({ "0": 800, "1": 200 }));
    feedLive("v1", 1000, () => 1);
    detector.runDriftCheck({ now: 1000 });
    detector.runDriftCheck({ now: 2000 }); // within cooldown
    detector.runDriftCheck({ now: 60_000 + 1000 }); // still boundary
    detector.runDriftCheck({ now: 61_000 + 1000 }); // past cooldown
    // First run: 2 critical alarms (psi+kl). Second/third: suppressed. Fourth: 2 emitted again.
    expect(emitted.length).toBe(4);
  });

  it("does not suppress when statistic or severity changes (escalation)", () => {
    const emitted: FraudDriftAlarm[] = [];
    const detector = new FraudDriftDetector({
      minLiveSamples: 50,
      flapCooldownMs: 60_000,
      emit: (p) => emitted.push(p),
      thresholds: { psiWarning: 0.1, psiCritical: 0.2, klWarning: 0.05, klCritical: 0.1 },
    });
    setFraudScoreBaseline("v1", buildHistogram({ "0": 1000, "1": 100 }));
    // Warning-only shift first
    feedLive("v1", 1100, (i) => (i % 10 === 0 ? 1 : 0));
    detector.runDriftCheck({ now: 100 });
    // Critical shift now
    feedLive("v1", 1000, () => 1);
    detector.runDriftCheck({ now: 200 });
    expect(emitted.length).toBeGreaterThanOrEqual(2);
    // the second run should produce at least one critical alarm not previously recorded
    expect(emitted.some((p) => p.severity === "critical")).toBe(true);
  });

  it("model swap (clear state) requires a new baseline before emitting again", () => {
    const emitted: FraudDriftAlarm[] = [];
    const detector = new FraudDriftDetector({
      minLiveSamples: 50,
      flapCooldownMs: 0,
      emit: (p) => emitted.push(p),
      thresholds: { psiWarning: 0.1, psiCritical: 0.2, klWarning: 0.05, klCritical: 0.1 },
    });
    setFraudScoreBaseline("v1", buildHistogram({ "0": 800, "1": 200 }));
    feedLive("v1", 1000, () => 1);
    detector.runDriftCheck({ now: 100 }); // emits

    // Model swap
    detector.resetForVersion("v1");
    feedLive("v1", 200, () => 1);
    const after = detector.runDriftCheck({ now: 200 });
    expect(after.results[0].skipped).toBe(true);
    expect(after.results[0].skipReason).toBe("no_baseline");
  });

  it("clearBaselineForVersion requires new baseline; subsequent baseline restores checks", () => {
    const detector = new FraudDriftDetector({ minLiveSamples: 50, flapCooldownMs: 0 });
    setFraudScoreBaseline("v1", buildHistogram({ "0": 100, "1": 50 }));
    feedLive("v1", 150, (i) => (i % 3 === 0 ? 1 : 0));
    detector.clearBaselineForVersion("v1");
    const skipped = detector.runDriftCheck({ now: 100 });
    expect(skipped.results[0].skipReason).toBe("no_baseline");

    detector.setBaseline("v1", buildHistogram({ "0": 100, "1": 50 }));
    // Re-feed matching proportions so live still matches the new baseline.
    feedLive("v1", 50, () => 0);
    const ok = detector.runDriftCheck({ now: 200 });
    expect(ok.results[0].severity).toBe("ok");
  });

  it("emits status gauge values per severity", async () => {
    const detector = new FraudDriftDetector({
      minLiveSamples: 50,
      flapCooldownMs: 0,
      thresholds: { psiWarning: 0.1, psiCritical: 0.2, klWarning: 0.05, klCritical: 0.1 },
    });
    // No baseline => status = 3 (no_baseline)
    feedLive("v1", 100, () => 0);
    detector.runDriftCheck({ now: 1 });

    setFraudScoreBaseline("v1", buildHistogram({ "0": 800, "1": 200 }));
    detector.runDriftCheck({ now: 2 }); // ok => 0

    feedLive("v1", 1000, () => 1);
    detector.runDriftCheck({ now: 3 }); // critical => 2

    const { register } = await import("../../metrics.js");
    const output = await register.metrics();
    expect(output).toMatch(/fraud_drift_status\{model_version="v1"\} 2/);
  });

  it("respects per-run thresholds override", () => {
    const emitted: FraudDriftAlarm[] = [];
    const detector = new FraudDriftDetector({
      minLiveSamples: 50,
      flapCooldownMs: 0,
      emit: (p) => emitted.push(p),
      thresholds: { psiWarning: 0.5, psiCritical: 0.7, klWarning: 0.5, klCritical: 0.7 },
    });
    setFraudScoreBaseline("v1", buildHistogram({ "0": 800, "1": 200 }));
    // Small shift: ~12% mass migrates from 0 to 1. PSI ≈ 0.05–0.10 (under both
    // constructor AND per-run warning thresholds). No alarm expected at all.
    feedLive("v1", 1000, (i) => (i % 8 === 0 ? 1 : 0));
    detector.runDriftCheck({ now: 5 });
    expect(emitted).toHaveLength(0);

    // Aggressive override triggers a critical alarm on the same distribution.
    detector.runDriftCheck({
      now: 6,
      thresholds: { psiWarning: 0.01, psiCritical: 0.02, klWarning: 0.01, klCritical: 0.02 },
    });
    expect(emitted.length).toBeGreaterThan(0);
  });

  it("suppresses repeat alarms within the flap cooldown window", () => {
    const emitted: FraudDriftAlarm[] = [];
    const detector = new FraudDriftDetector({
      minLiveSamples: 50,
      flapCooldownMs: 60_000,
      emit: (p) => emitted.push(p),
      thresholds: { psiWarning: 0.1, psiCritical: 0.2, klWarning: 0.05, klCritical: 0.1 },
    });
    setFraudScoreBaseline("v1", buildHistogram({ "0": 800, "1": 200 }));
    feedLive("v1", 1000, () => 1);
    detector.runDriftCheck({ now: 1000 }); // emits psi+kl critical
    const first = emitted.length;
    expect(first).toBeGreaterThan(0);

    // Within cooldown → suppressed for the same (version, severity, statistic).
    detector.runDriftCheck({ now: 30_000 });
    expect(emitted.length).toBe(first);

    // Cache refresh: at now=70_000 the cooldown has elapsed since the first
    // emission; second alarm fires again.
    detector.runDriftCheck({ now: 70_000 });
    expect(emitted.length).toBe(first + 2);

    // Subsequent run at now=80_000 falls within the cooldown of the second
    // emission; should be suppressed again.
    detector.runDriftCheck({ now: 80_000 });
    expect(emitted.length).toBe(first + 2);
  });

  it("handles multiple model versions in a single report", () => {
    const detector = new FraudDriftDetector({ minLiveSamples: 25, flapCooldownMs: 0 });
    setFraudScoreBaseline("v1", buildHistogram({ "0": 100 }));
    setFraudScoreBaseline("v2", buildHistogram({ "1": 100 }));
    feedLive("v1", 50, () => 0);
    feedLive("v2", 50, () => 0); // very dissimilar to v2's baseline
    const report = detector.runDriftCheck({ now: 7 });
    expect(report.results).toHaveLength(2);
    const byVersion = Object.fromEntries(report.results.map((r) => [r.modelVersion, r]));
    expect(byVersion.v1.severity).toBe("ok");
    expect(byVersion.v2.severity).not.toBe("ok");
  });

  it("startDetector / stopDetector fire the periodic check and can be torn down", async () => {
    jest.useFakeTimers();
    const emitted: FraudDriftAlarm[] = [];
    const detector = new FraudDriftDetector({
      minLiveSamples: 25,
      flapCooldownMs: 0,
      emit: (p) => emitted.push(p),
      thresholds: { psiWarning: 0.1, psiCritical: 0.2, klWarning: 0.05, klCritical: 0.1 },
    });
    setFraudScoreBaseline("v1", buildHistogram({ "0": 800, "1": 200 }));
    feedLive("v1", 100, () => 1);

    // Drive Date.now so the emitted timestamp is deterministic.
    const fixedNow = 5_000_000;
    const dateSpy = jest.spyOn(Date, "now").mockReturnValue(fixedNow);

    // Restore the spy and switch back to real timers no matter how this
    // assertion chain exits — otherwise a failure leaks the mock into
    // subsequent tests.
    let timer: NodeJS.Timeout | null = null;
    try {
      timer = detector.startDetector(1_000);
      jest.advanceTimersByTime(1_000);
      jest.advanceTimersByTime(1_000);
      jest.advanceTimersByTime(1_000);

      expect(emitted.length).toBeGreaterThanOrEqual(2);

      detector.stopDetector(timer);
      timer = null;
      const beforeTearDown = emitted.length;
      jest.advanceTimersByTime(10_000);
      expect(emitted.length).toBe(beforeTearDown);
    } finally {
      if (timer) detector.stopDetector(timer);
      dateSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it("stopDetector is a no-op for null timers", () => {
    const detector = new FraudDriftDetector();
    expect(() => detector.stopDetector(null)).not.toThrow();
    expect(() => detector.stopDetector(undefined)).not.toThrow();
  });

  it("singleton accessor returns the same instance per process", async () => {
    const mod = await import("../fraudDriftDetector.js");
    const a = mod.getFraudDriftDetector();
    const b = mod.getFraudDriftDetector();
    expect(a).toBe(b);
    // Reset at the end so other tests start clean.
    mod.resetFraudDriftSingleton();
  });

  it("does not emit when score values are normal but statistics are ok", () => {
    const emitted: FraudDriftAlarm[] = [];
    const detector = new FraudDriftDetector({
      minLiveSamples: 50,
      flapCooldownMs: 0,
      emit: (p) => emitted.push(p),
    });
    setFraudScoreBaseline("v1", buildHistogram({ "0": 100, "1": 50 }));
    // Match the baseline proportions exactly.
    feedLive("v1", 200, (i) => (i % 3 === 0 ? 1 : 0));
    detector.runDriftCheck({ now: 1 });
    expect(emitted).toHaveLength(0);
  });

  it("flap guard allows escalation even within the cooldown window", () => {
    const emitted: FraudDriftAlarm[] = [];
    const detector = new FraudDriftDetector({
      minLiveSamples: 50,
      flapCooldownMs: 60_000,
      emit: (p) => emitted.push(p),
      thresholds: { psiWarning: 0.1, psiCritical: 0.2, klWarning: 0.05, klCritical: 0.1 },
    });
    setFraudScoreBaseline("v1", buildHistogram({ "0": 1000, "1": 100 }));
    // Warning-level shift first.
    feedLive("v1", 1100, (i) => (i % 6 === 0 ? 1 : 0));
    detector.runDriftCheck({ now: 100 });
    const firstCount = emitted.length;

    // Within cooldown but severity escalates to critical.
    feedLive("v1", 1000, () => 1); // shift goes critical
    detector.runDriftCheck({ now: 200 });
    expect(emitted.length).toBeGreaterThan(firstCount);
    expect(emitted.some((p) => p.severity === "critical")).toBe(true);
  });

  it("startDetector clamps sub-second intervals to the minimum (1s)", () => {
    // Spy on the real `setInterval` so we can read the delay argument the
    // detector actually forwards after the clamp rules apply. We capture the
    // args in a list AND keep every returned Timeout so we can `clearInterval`
    // each one before the test returns. Without explicit cleanup the 5 real
    // timers (some scheduled for hundreds of seconds) would stay alive in
    // Node's timer queue and fire later, mutating the shared registry for
    // unrelated tests and inflating the suite runtime.
    const calls: Array<unknown[]> = [];
    const timeouts: NodeJS.Timeout[] = [];
    const originalSetInterval = global.setInterval;
    const fakeSetInterval = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
      calls.push([handler, delay, ...rest]);
      // Forward to the real implementation with type-aligned casts.
      const t = originalSetInterval(
        handler as Parameters<typeof originalSetInterval>[0],
        delay as Parameters<typeof originalSetInterval>[1],
        ...(rest as []),
      );
      timeouts.push(t);
      return t;
    }) as unknown as typeof setInterval;
    global.setInterval = fakeSetInterval;
    try {
      const detector = new FraudDriftDetector();
      detector.startDetector(-1);
      detector.startDetector(0);
      detector.startDetector(60_000);
      detector.startDetector(NaN);
      detector.startDetector(Number.POSITIVE_INFINITY);

      // 5 scheduled intervals; second arg is the forwarded delay.
      // NOTE: DEFAULT_INTERVAL_MS is captured at module import from
      // `FRAUD_DRIFT_INTERVAL_MS` env. Asserting against the imported value
      // keeps the test honest about both detector behavior AND its current
      // configuration, without assuming any particular env baseline.
      const delays = calls.map((c) => c[1]);
      expect(delays).toEqual([
        MIN_DETECTOR_INTERVAL_MS, // -1 → floor
        MIN_DETECTOR_INTERVAL_MS, // 0  → floor
        60_000,                   // 60s → unchanged
        DEFAULT_INTERVAL_MS,      // NaN → default
        DEFAULT_INTERVAL_MS,      // Infinity → default
      ]);
    } finally {
      for (const t of timeouts) clearInterval(t);
      global.setInterval = originalSetInterval;
    }
  });
});
