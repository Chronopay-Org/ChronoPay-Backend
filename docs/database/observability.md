# Database Observability

## Slow-query logging and metrics

ChronoPay instruments every query wrapped with `instrumentQuery()` and emits structured logs and Prometheus metrics when a query exceeds a configurable threshold.

### Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `SLOW_QUERY_THRESHOLD_MS` | No | _(disabled)_ | Queries taking at least this many milliseconds are flagged as slow. Must be a positive integer. Omit or leave unset to disable slow-query detection entirely. |

```bash
# Enable slow-query detection at 500 ms
SLOW_QUERY_THRESHOLD_MS=500 npm run dev
```

### Log output

When a query exceeds the threshold, a `WARN`-level structured log is emitted via the application logger:

```json
{
  "level": "WARN",
  "msg": "[ChronoPay] slow query detected",
  "query": "SELECT * FROM slots WHERE ...",
  "durationMs": 823,
  "threshold": 500
}
```

**Security note:** only the query text is logged. Query parameters are never included to prevent accidental leakage of PII or secrets.

### Metrics

Two Prometheus metrics are exported from `src/metrics.ts`:

| Metric | Type | Description |
|---|---|---|
| `db_slow_queries_total` | Counter | Incremented once per slow query detected. |
| `db_slow_query_duration_ms` | Histogram | Records the duration (ms) of each slow query. Buckets: 100, 250, 500, 1000, 2500, 5000, 10000. |

Metrics are available at the `/metrics` endpoint (Prometheus scrape target).

### Usage

Wrap any query execution with `instrumentQuery`:

```typescript
import { instrumentQuery } from "../db/connection.js";

const result = await instrumentQuery(
  "SELECT * FROM slots WHERE owner_id = $1",
  () => pool.query("SELECT * FROM slots WHERE owner_id = $1", [ownerId]),
);
```

The first argument is the query text used for logging. Query parameters are passed only to the executor function and are never forwarded to the logger.

### Security assumptions

- Query parameters (`$1`, `$2`, …) are passed exclusively to the database driver and are never logged.
- The query text itself may contain table/column names but must not be constructed by interpolating user input directly into the string — use parameterised queries.
- The `SLOW_QUERY_THRESHOLD_MS` value is validated at startup; a non-integer or zero value causes a fast-fail with a descriptive error.

### Disabling

Remove or unset `SLOW_QUERY_THRESHOLD_MS`. When the variable is absent, `instrumentQuery` adds no overhead beyond a `Date.now()` call and a null check.
