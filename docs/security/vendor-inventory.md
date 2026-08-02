# SOC2 Vendor Inventory

ChronoPay maintains a lightweight, in-repo inventory of third-party vendors
required for SOC 2 (CC3.1 / vendor risk management). It tracks each vendor's
risk score, criticality, invoicing currency, and the date of the most recent
risk review.

## Files

| File                                                                                     | Purpose                                                                          |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [`vendors.yaml`](vendors.yaml)                                                           | The vendor registry itself (single source of truth).                             |
| [`vendor-registry.schema.json`](vendor-registry.schema.json)                             | JSON Schema describing the registry shape.                                       |
| [`scripts/vendor-inventory-check.ts`](../../scripts/vendor-inventory-check.ts)           | Validator + freshness checker run by CI.                                         |
| [`.github/workflows/vendor-inventory.yml`](../../.github/workflows/vendor-inventory.yml) | CI job: fails on stale/duplicate/invalid entries and posts a summary PR comment. |

## Adding or updating a vendor

1. Add (or edit) an entry in `vendors.yaml`:

   ```yaml
   - id: example-vendor
     name: Example Vendor Inc.
     category: analytics
     service: product analytics dashboards
     owner: data-team
     risk_score: 2
     criticality: medium
     currency: USD
     review_date: 2026-08-01
     review_cadence_months: 12
     data_classification: confidential
     notes: Shared only aggregated, non-personal metrics.
   ```

2. Open a PR. CI validates the registry and posts a summary comment with the
   per-vendor next review date.

### Required fields

- `id` — unique slug (`^[a-z0-9][a-z0-9-]*$`); **duplicates fail CI**.
- `name`, `category`, `service`, `owner` — free-form strings.
- `risk_score` — integer 1–5; **a missing risk score fails CI**.
- `criticality` — `low | medium | high | critical`.
- `currency` — 3-letter ISO code, must be listed in `allowed_currencies`;
  a **currency change without a fresh `review_date` fails CI** (the change
  must be preceded by a re-review).
- `review_date` — ISO date (YYYY-MM-DD) of the last review; must not be in
  the future.

### Optional fields

- `review_cadence_months` — tighter cadence (default 12; never looser, CI
  enforces the 12-month maximum).
- `data_classification` — highest classification of shared data.
- `notes` — context for the reviewer.

## Review cadence

- Every entry must be reviewed **at least once every 12 months**.
- CI fails if any `review_date` is older than 12 months.
- CI warns when an entry is within 3 months of the limit so reviews can be
  scheduled before the deadline.

## How CI enforces this

`.github/workflows/vendor-inventory.yml` runs on any PR that touches the
registry (or the checker itself):

```
npx tsx scripts/vendor-inventory-check.ts
```

- Exit code 0 → valid and fresh.
- Exit code 1 → invalid, stale, duplicated, or unreviewed currency change.
- When run with `GITHUB_TOKEN`, `GITHUB_REPOSITORY` and `PR_NUMBER` set (CI),
  it posts a summary comment on the PR.

Run the same check locally:

```
npx tsx scripts/vendor-inventory-check.ts
```

## Edge cases covered

- Missing `risk_score` → error.
- Duplicate vendor `id` → error.
- `currency` not in `allowed_currencies` → error.
- `currency` changed vs. the PR base branch without updating `review_date` → error.
- `review_date` older than 12 months → error; within 3 months of the limit → warning.
- Malformed dates, future dates, out-of-range risk scores → error.
