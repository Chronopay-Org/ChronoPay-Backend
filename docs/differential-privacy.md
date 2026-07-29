# Differential Privacy for Analytics Exports

## Overview

Analytics exports from the audit log carry aggregate counts (events per action,
events per service) that could allow re-identification of individuals even after
field-level PII redaction. This document describes the differential-privacy (DP)
mechanism added in [#515](https://github.com/Chronopay-Org/ChronoPay-Backend/issues/515)
to protect against that risk.

## Background: why DP noise?

Standard redaction removes identifiers like names and IP addresses, but
publication of exact aggregate counts can still leak information through
*differencing attacks*: an adversary who queries two similar exports and
subtracts the counts can infer whether a specific individual was present.

[Differential privacy](https://en.wikipedia.org/wiki/Differential_privacy) (Dwork & Roth 2014)
provides a mathematically rigorous guarantee: the probability distribution of
any published output changes by at most a factor of e^ε when any single
individual's record is added or removed from the dataset.  Smaller ε means
stronger privacy at the cost of more noise.

## Mechanism: Laplace noise

We use the **Laplace mechanism**, the canonical approach for numeric queries.

For a query with **L1-sensitivity Δf** and budget **ε**, noise is drawn from:

```
Lap(0, Δf / ε)
```

For COUNT queries (how many events have action X?) sensitivity **Δf = 1**,
because adding or removing one record changes the count by at most 1.

The noise scale is therefore:

```
b = 1 / ε
```

Lower ε → larger b → more noise → stronger privacy guarantee.

### Post-processing

After adding noise, each count is:
1. **Clamped** to `[0, +∞)` — negative counts are semantically invalid.
2. **Rounded** to the nearest integer — counts are discrete.

Post-processing does not consume additional epsilon budget (it is applied to
an already DP output).

### Cryptographic RNG

Noise is sampled using the **inverse-CDF method** with `crypto.getRandomValues`
(the Node.js Web Crypto API) as the source of randomness.  This is
cryptographically secure and does not depend on `Math.random()`.

## What gets noised

Every analytics export appended to the audit log NDJSON contains a final line
with `"_type": "analytics_summary"`:

```jsonc
{
  "_type": "analytics_summary",
  "totalEvents": 142,                // noised
  "countsByAction": {
    "user.login": 74,                // noised
    "payment.created": 68            // noised
  },
  "countsByService": {
    "chronopay-backend": 142         // noised
  },
  "differentialPrivacy": {
    "mechanism": "laplace",
    "epsilon": 1.0,
    "sensitivity": 1,
    "noiseScale": 1.0,
    "appliedAt": "2026-07-29T10:00:00.000Z"
  }
}
```

Raw event lines (with field-level PII redaction) are unchanged and appear
before the summary line.

## Epsilon budget tracking

Each export consumes ε from a per-dataset **epsilon budget**.  Under sequential
composition, the total privacy loss after *k* exports is:

```
ε_total = Σ ε_i
```

The `EpsilonBudgetTracker` enforces a configurable cap and fires structured
alarms at two thresholds:

| Threshold | Alarm level | Behaviour |
|-----------|-------------|-----------|
| ≥ 80 %   | `warning`   | Alarm event emitted; export still allowed |
| = 100 %  | `exhausted` | Alarm event emitted; export still allowed at exactly budget |
| > 100 %  | —           | `BudgetExhaustedError` thrown; export blocked |

### Alarm format

```jsonc
{
  "datasetId": "audit_events",
  "level": "warning",               // or "exhausted"
  "epsilonSpent": 8.1,
  "epsilonBudget": 10.0,
  "fractionSpent": 0.81,
  "timestamp": "2026-07-29T10:00:00.000Z",
  "message": "[DP ALARM] Epsilon budget WARNING for dataset \"audit_events\" — 81.0% used (8.1000 / 10.0000)."
}
```

Alarms are routed to `console.warn` by default.  Production deployments should
inject a custom `BudgetAlarmSink` that forwards to the observability pipeline
(e.g. Pino, Prometheus alert, PagerDuty).

## Configuration

All settings are controlled via environment variables.  No code changes are
required to tune epsilon or budgets per environment.

### `CHRONOPAY_DP_EPSILON`

The ε value applied to each export.

- **Type:** positive float
- **Default:** `1.0`
- **Example:** `CHRONOPAY_DP_EPSILON=0.5`

Guidance:
- ε ≤ 0.1 — very strong privacy, high noise (use for sensitive cohorts)
- ε = 1.0 — balanced default (recommended for audit exports)
- ε ≥ 10 — minimal noise; treat counts as near-exact

### `CHRONOPAY_DP_ENABLED`

Toggle DP noise on/off.  Use `false` **only in local development**.  Exports
with DP disabled will carry `"dpDisabled": true` in the summary so consumers
know exact counts are present.

- **Type:** `"true"` | `"false"`
- **Default:** `"true"`

### `CHRONOPAY_DP_EPSILON_BUDGET_<DATASET>`

Total epsilon budget for a dataset.  The dataset identifier is
`audit_events`, so the variable is:

```
CHRONOPAY_DP_EPSILON_BUDGET_AUDIT_EVENTS=50
```

- **Type:** positive float
- **Default:** `10.0`

When the budget is exhausted, all further exports for that dataset throw
`BudgetExhaustedError` until an operator resets the spend counter.

### Resetting the budget

To start a new accounting period call `EpsilonBudgetTracker.resetSpend`:

```typescript
import { defaultEpsilonBudgetTracker } from "./src/services/epsilonBudgetTracker.js";

await defaultEpsilonBudgetTracker.resetSpend("audit_events");
```

This clears accumulated spend without changing the budget cap.

## Security considerations

### Sensitivity assumption

The sensitivity is fixed at **1** for all COUNT queries.  This holds as long
as each individual can contribute at most one event per counted bucket.  If an
individual can appear multiple times (e.g. session events), the sensitivity
must be set to the maximum number of contributions per individual and the noise
scale adjusted accordingly.

### Floating-point DP

Floating-point arithmetic can in principle introduce bias in DP noise
([Mironov 2012](https://www.microsoft.com/en-us/research/publication/on-significance-of-the-least-significant-bits-for-differential-privacy/)).
Our implementation mitigates this by **clamping and rounding to integers**
before publishing.  The noise is applied at the floating-point level, but the
published value is always a non-negative integer, which eliminates the
carry-bit attack described by Mironov.

### Budget exhaustion under concurrent requests

The budget check and charge are serialised inside the existing `JobQueue`
to prevent race conditions on the shared in-memory store.  For multi-instance
deployments, replace `InMemoryBudgetStore` with a Redis-backed implementation
that uses atomic compare-and-swap.

### Audit log of DP usage

Every `createExport` call appends an `audit.export.requested` event to the
audit log that includes `dpEnabled` and `dpEpsilon` in its context payload,
providing an immutable record of DP parameters used.

## File map

| File | Purpose |
|------|---------|
| `src/utils/differentialPrivacy.ts` | Laplace mechanism, validation, metadata builder |
| `src/services/epsilonBudgetTracker.ts` | Per-dataset epsilon accounting and alarms |
| `src/services/auditExportService.ts` | Export pipeline — aggregation, DP noise, budget charge |
| `src/utils/__tests__/differentialPrivacy.test.ts` | Unit tests for DP utilities |
| `src/services/__tests__/epsilonBudgetTracker.test.ts` | Unit tests for budget tracker |
| `src/services/__tests__/auditExportService.test.ts` | Integration tests including DP cases |

## References

- C. Dwork, A. Roth, "The Algorithmic Foundations of Differential Privacy", *Foundations and Trends in Theoretical Computer Science*, 2014.
- I. Mironov, "On Significance of the Least Significant Bits for Differential Privacy", *CCS 2012*.
- [Wikipedia — Differential privacy](https://en.wikipedia.org/wiki/Differential_privacy)
- [Wikipedia — Laplace distribution](https://en.wikipedia.org/wiki/Laplace_distribution)
