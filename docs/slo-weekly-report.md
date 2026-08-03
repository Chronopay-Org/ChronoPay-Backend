# Weekly SLO Error-Budget Report

Automated weekly Slack summary of SLO error-budget consumption per route.

## Routes and objectives

Aligned with `src/metrics/sloMetrics.ts`:

| Route | Objective |
|-------|-----------|
| `booking_intent` | 99.9% |
| `slots_list` | 99.5% |
| `checkout` | 99.99% |
| `escrow_listener` | 99% |

## Budget math

For each route over the past 7 days:

```
errorBudget      = 1 − sloObjective
observedErrorRate = badEvents / totalRequests   (0 when no traffic)
consumedFraction  = observedErrorRate / errorBudget
remainingBudget   = clamp(1 − consumedFraction, 0, 1)
```

Weekly consumption shown in Slack is `consumedFraction × 100%` of the error budget.

## Data sources

The script (`scripts/slo-weekly-report.ts`) resolves data in order:

1. **Prometheus counters** — `increase(slo_requests_total[7d])` and `increase(slo_bad_events_total[7d])` (or `slo_route_*` variants) when present.
2. **`slo_burn_rate` gauge** — max over the week per route when counters are absent.
3. **No-traffic defaults** — all four routes at 100% remaining with a _no traffic_ marker when Prometheus is empty or unreachable.

## Slack message

- Per-route leaderboard sorted worst-first (lowest remaining budget)
- Remaining budget %, weekly consumption %, status (Exhausted / Critical / At Risk / Healthy)
- Link to the [SLO burn-rate dashboard](../ops/dashboards/slo-burn-rate.json) (`uid: slo-burn-rate`)

## Running locally

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... \
PROMETHEUS_URL=http://localhost:9090 \
BURN_RATE_DASHBOARD_URL=https://grafana.example.com/d/slo-burn-rate \
npx tsx scripts/slo-weekly-report.ts
```

Environment defaults (when unset):

- `PROMETHEUS_URL` — empty (posts no-traffic defaults)
- `BURN_RATE_DASHBOARD_URL` — `https://grafana.example.com/d/slo-burn-rate`

## CI schedule

GitHub Actions workflow `.github/workflows/slo-weekly-report.yml` runs every **Monday at 09:00 UTC** and supports manual `workflow_dispatch`.

Required secrets:

- `SLACK_WEBHOOK_URL` (required)
- `PROMETHEUS_URL` (optional)
- `BURN_RATE_DASHBOARD_URL` (optional)

Slack delivery failures throw so the cron job fails loudly.

## Tests

```bash
npm test -- --testPathPattern='slo-weekly-report' --coverage=false
```
