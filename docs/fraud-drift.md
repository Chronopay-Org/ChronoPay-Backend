# Fraud score drift detection

## What is drift?

Fraud scoring is a moving target. The `FraudScorer` emits a small integer
`score` per booking intent (range 0–8 in the current implementation).
That score distribution is shaped by:

- the rule weights (`FRAUD_VELOCITY_WINDOW_MS`, `FRAUD_DISPOSABLE_LIST`, etc.),
- the composition of incoming traffic (more socks? new region?), and
- upstream behaviour changes we can't always see from the inside.

If the live histogram of fraud scores diverges from the training
distribution, the rule weights that were tuned against the training set
will start to misfire in production: too many false positives (CX hit) or
too many false negatives (real fraud getting through). Catching that
**early** is the job of this detector.

## Implementation

Source of truth: `src/services/fraudDriftDetector.ts`,
`src/services/fraudDriftMath.ts`, `src/metrics/fraudDriftMetrics.ts`.

- **Per-model-version histograms.** Each `recordScore(modelVersion, score)`
  feeds the canonical 10-bin histogram for that `modelVersion` (labels
  `0 1 2 3 4 5 6 7 8 9+`).
- **Drift statistic.** Every check interval (default 5 minutes), the
  detector normalises the live histogram and the frozen baseline
  (Laplace ε-smoothing so sparse histograms stay finite) and computes
  both PSI and Kullback-Leibler divergence.
- **Alarms.** When either statistic crosses the configured thresholds
  (see below) the detector:
  1. emits a structured log line `{ code: "FRAUD_DRIFT_ALARM", …, runbook }` at `error` level,
  2. increments `fraud_drift_alerts_total{model_version,severity,statistic}`, and
  3. updates `fraud_drift_status{model_version}` to `1` (warning) or `2` (critical).
- **Flap guard.** Repeat alarms for the same `(modelVersion, severity, statistic)`
  tuple within `FRAUD_DRIFT_FLAP_COOLDOWN_MS` (default 30m) are suppressed.
  This prevents a model hovering around the threshold from paging on every tick.

## Thresholds

Both PSI and KL are exposed and tunable.

| Statistic | ok       | warning  | critical |
|-----------|----------|----------|----------|
| PSI       | `< 0.1`  | `>= 0.1` | `>= 0.2` |
| KL        | `< 0.05` | `>= 0.05`| `>= 0.1` |

These are the defaults; override via the constructor when integrating
in tests, or via env vars in production:

| Env var                       | Default                         |
|-------------------------------|---------------------------------|
| `FRAUD_DRIFT_ENABLED`         | unset (detector dormant)        |
| `FRAUD_DRIFT_INTERVAL_MS`     | 300000 (5 min; clamped to a 1000 ms floor) |
| `FRAUD_DRIFT_FLAP_COOLDOWN_MS`| 1800000 (30 min)                |
| `FRAUD_DRIFT_MIN_SAMPLES`     | 50                              |
| `FRAUD_DRIFT_RUNBOOK_URL`     | `https://runbooks.chronopay.local/fraud/drift-detector` |

`FRAUD_DRIFT_INTERVAL_MS` is clamped to a 1-second floor so any sub-second
or non-positive value gets promoted to at least one second. Values that
cannot be parsed as a finite number (NaN, ±Infinity) fall back to the
default. This protects the event loop from a misconfigured deployment
accidentally scheduling tight recurring checks.

## Metrics

| Metric                                            | Labels                              | Type    | Purpose |
|---------------------------------------------------|-------------------------------------|---------|---------|
| `fraud_drift_psi`                                 | `model_version` (budget=8)          | gauge   | Current PSI value per active model version. |
| `fraud_drift_kl`                                  | `model_version` (budget=8)          | gauge   | Current KL value per active model version.  |
| `fraud_drift_status`                              | `model_version` (budget=8)          | gauge   | Most recent severity: 0=ok, 1=warning, 2=critical, 3=no_baseline. |
| `fraud_drift_alerts_total`                        | `model_version`, `severity`, `statistic` (budget=64) | counter | Alarm emission counter. |

All metrics go through the budgeted registry in `src/metrics.ts`, so
attacker-controlled label values cannot blow up cardinality. When the
budget is exhausted, observations are relabelled to `__overflow__` and
`metric_cardinality_overflow_total{metric="..."}` ticks up.

## Grafana dashboard

`ops/dashboards/fraud-drift.json`:

- **PSI / KL trend** with threshold bands (green/yellow/red).
- **Current status** stat panel (mappings convert 0/1/2/3 to labels).
- **Tracked model versions** count.
- **Cardinality overflow** rate.
- **Alarm rate** by severity × statistic in the last 5 minutes.

Upload and validate using the existing `scripts/upload-dashboards.ts` /
`scripts/validate-dashboards.ts` (they iterate every file under
`ops/dashboards/`).

## Alerting

`ops/alerts/fraud-drift.rules.yml`:

- `FraudDriftPSICritical` — page (10m sustained `psi >= 0.2`).
- `FraudDriftPSIWarning` — ticket (30m sustained `psi >= 0.1`).
- `FraudDriftKLCritical` — page (10m sustained `kl >= 0.1`).
- `FraudDriftKLWarning` — ticket (30m sustained `kl >= 0.05`).
- `FraudDriftMissingBaseline` — ticket (15m of `status == 3`).
- `FraudDriftMetricCardinalityOverflow` — ticket (cardinality relabelling).

All alerts carry a `runbook_url` annotation pointing back to this page
and a `dashboard_url` annotation pointing to the Grafana board.

## Runbook

### I was just paged: PSI critical

1. Open the Grafana dashboard and filter to the offending
   `model_version`. Is the shift monotonically growing or oscillating?
2. Check `git log` and the change calendar for recent fraud rule
   changes or model rollouts. If a rollout happened within the last
   hour, **freeze the active model** (set the `FRAUD_MODEL_VERSION`
   env in the previous-version deployment) and refresh the baseline
   histogram from the held-out training set.
3. If no rollout happened: it is likely a behavioural shift in
   traffic. Pull a sample of recent cases from the booking intents
   table, bucket them by `score`, and confirm the dashboard's
   histogram is consistent with what you see in raw data.
4. Lower the page's threshold if you are confident this is benign
   seasonal drift (e.g. sale event). Otherwise keep the alarm live and
   open a fraud team ticket.

### I was just paged: no baseline

The most common cause is a new model version deployed without the
baseline refresh script running. The fix is to:

1. Pull the held-out score distribution from the training runbook.
2. Calculate the per-bin counts.
3. Call `setFraudScoreBaseline(modelVersion, histogram)` from the
   migration script (or `setBaseline` on `FraudDriftDetector`).

Until the baseline is set, the detector continues to log
`FRAUD_DRIFT_CHECK_FAILED` with `skipReason="no_baseline"` to help
the operator confirm the fix.

### Flap is suppressing useful alarms

The flap guard is keyed on `(modelVersion, severity, statistic)`. If
the alarm is being suppressed **after a real escalation** (warning →
critical), the cache key changes so the alarm should fire. If it is
being suppressed at consistent severity, lower the cooldown:

```
FRAUD_DRIFT_FLAP_COOLDOWN_MS=300000   # 5 min
```

Reload the process to pick up the new value.

## Security notes

- No PII (IP, fingerprint, user ID, actor ID) ever appears in metric
  labels or alert annotations. The histogram is bucketed onto fixed
  bins and metric labels are bounded enums.
- `model_version` has a cardinality budget of 8. When exceeded, new
  versions collapse to `__overflow__` and `metric_cardinality_overflow_total`
  is incremented.
- `setFraudScoreBaseline` canonicalises unknown keys into the `9+`
  overflow bin and drops non-positive counts to prevent a malformed
  baseline from breaking the math.
- The detector logs structured JSON; the global logger in
  `src/utils/logger.ts` redacts known sensitive headers and bodies.
- Drift statistics are bounded by configuration (positive `epsilon`
  is required, negative `epsilon` makes `normalizeToDistribution` return
  `null` and the run is reported as `skipReason: "no_baseline"`).

## Testing

`src/services/__tests__/fraudDriftMath.test.ts` covers the pure math:
PSI ≈ 0 for identical distributions, monotonicity as distributions
diverge, smoothing under sparse histograms, asymmetric KL.

`src/services/__tests__/fraudDriftDetector.test.ts` covers detector
behaviour: skipped result for missing baseline / insufficient data,
warning vs critical thresholds, alarm payload shape, flap guard
suppression + escalation, model swap, multi-version reports, lifecycle
under `setInterval`.

`src/__tests__/fraudDriftMetrics.test.ts` covers the singleton:
per-version isolation, canonicalisation (negative / `NaN`/unknown keys),
overflow behaviour past the model-version budget, and snapshot/reset
for test isolation.

## Edge cases

- **Sparse histograms:** Laplace ε-smoothing on both sides keeps PSI
  and KL finite for any non-degenerate input. Empty histogram from a
  brand-new model version is treated as a smoothed uniform and yields
  PSI ≈ 0.
- **Model swap:** `clearFraudDriftState(modelVersion)` resets both live
  counts and baseline; the next drift check fires
  `skipReason: "no_baseline"` until the operator refreshes the
  baseline. The flap guard cache is per-version-keyed so old alarms do
  not re-fire.
- **Threshold flap:** alarms are suppressed within the configured
  cooldown window for the same `(modelVersion, severity, statistic)`
  tuple. Severity escalation (warning → critical) produces a different
  cache key, so escalations always page.
