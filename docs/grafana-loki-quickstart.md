# Grafana Loki Quickstart for ChronoPay Structured Logs

ChronoPay emits **newline-delimited JSON** (NDJSON) via [pino](https://getpino.io/).
Every log line contains `req_id` and `trace_id` as top-level fields, making it
trivial to correlate logs with traces and request flows in Loki.

## Log shape

```json
{
  "level": "INFO",
  "time": "2026-07-30T12:00:00.000Z",
  "req_id": "req_550e8400-e29b-41d4-a716-446655440000",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "service": "chronopay-backend",
  "environment": "production",
  "msg": "[ChronoPay] slot created"
}
```

## Prerequisites

| Component | Version |
|-----------|---------|
| Grafana   | ≥ 10.x  |
| Loki      | ≥ 2.9   |
| Promtail  | ≥ 2.9 (or Alloy / Vector) |

## 1. Run Loki + Grafana locally (Docker Compose)

Add the following to your `docker-compose.yml` (or a new file
`docker-compose.loki.yml`):

```yaml
version: "3.8"

services:
  loki:
    image: grafana/loki:2.9.4
    ports:
      - "3100:3100"
    command: -config.file=/etc/loki/local-config.yaml
    volumes:
      - loki-data:/loki

  promtail:
    image: grafana/promtail:2.9.4
    volumes:
      - /var/log:/var/log
      - ./promtail-config.yaml:/etc/promtail/config.yaml
    command: -config.file=/etc/promtail/config.yaml
    depends_on:
      - loki

  grafana:
    image: grafana/grafana:10.4.0
    ports:
      - "3000:3000"
    environment:
      - GF_AUTH_ANONYMOUS_ENABLED=true
      - GF_AUTH_ANONYMOUS_ORG_ROLE=Admin
    volumes:
      - grafana-data:/var/lib/grafana
    depends_on:
      - loki

volumes:
  loki-data:
  grafana-data:
```

Start the stack:

```bash
docker-compose -f docker-compose.loki.yml up -d
```

## 2. Promtail configuration

Create `promtail-config.yaml` in the project root:

```yaml
server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /tmp/positions.yaml

clients:
  - url: http://loki:3100/loki/api/v1/push

scrape_configs:
  - job_name: chronopay-backend
    static_configs:
      - targets:
          - localhost
        labels:
          job: chronopay-backend
          environment: development
          __path__: /var/log/chronopay/*.log

    pipeline_stages:
      # Parse the NDJSON emitted by pino
      - json:
          expressions:
            req_id: req_id
            trace_id: trace_id
            span_id: span_id
            level: level
            service: service
            environment: environment

      # Promote structured fields to Loki labels for efficient querying
      - labels:
          level:
          service:
          environment:

      # Store req_id / trace_id as structured metadata (Loki ≥ 2.9)
      - structured_metadata:
          req_id:
          trace_id:
          span_id:
```

> **Tip:** If you are shipping logs over stdout (e.g., Docker / Kubernetes),
> replace `__path__` with a `docker_sd_configs` or `kubernetes_sd_configs`
> stanza that selects the `chronopay-backend` container.

## 3. Add Loki as a Grafana data source

1. Open Grafana at <http://localhost:3000>.
2. Go to **Connections → Data sources → Add data source**.
3. Choose **Loki**.
4. Set the URL to `http://loki:3100`.
5. Click **Save & test**.

## 4. Useful LogQL queries

### All logs for a specific request

```logql
{job="chronopay-backend"} | json | req_id = "req_550e8400-e29b-41d4-a716-446655440000"
```

### All logs belonging to a distributed trace

```logql
{job="chronopay-backend"} | json | trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"
```

### Error logs in the last 30 minutes

```logql
{job="chronopay-backend", level="ERROR"} | json
```

### Error rate by service over time (metric query)

```logql
sum(rate({job="chronopay-backend", level="ERROR"}[1m])) by (service)
```

### Slow requests (requires `durationMs` field)

```logql
{job="chronopay-backend"} | json | durationMs > 1000
```

### Correlate with Tempo traces

If you have Grafana Tempo configured, Grafana can auto-link logs to traces.
In the Loki data source settings, set the **Derived fields** → **Internal link**
to your Tempo data source using `trace_id` as the match expression.

## 5. Running ChronoPay so pino writes to stdout

In development pino uses `pino-pretty` for human-readable output. To get raw
NDJSON (required for Loki ingestion), set `NODE_ENV=production`:

```bash
NODE_ENV=production npm start | tee /var/log/chronopay/app.log
```

Or redirect stdout to a file and let Promtail tail it:

```bash
NODE_ENV=production node dist/index.js >> /var/log/chronopay/app.log 2>&1 &
```

## 6. Kubernetes / Helm

When running in Kubernetes, the recommended approach is to use the
[Grafana Alloy](https://grafana.com/docs/alloy/) DaemonSet (or the legacy
Promtail DaemonSet) to collect pod stdout and forward it to Loki.  Label your
pod with `app: chronopay-backend` and configure the Alloy `loki.source.kubernetes`
component to select it.

All `req_id` and `trace_id` fields will be available as structured metadata
without any additional pipeline stages because pino already emits them at the
top level of each JSON line.

## 7. Security notes

- ChronoPay **redacts** sensitive fields (`authorization`, `cookie`,
  `x-api-key`, `password`, `secret`, `token`) before they reach the logger.
  These fields are replaced with `[REDACTED]` or a masked value and will never
  appear in Loki.
- Do **not** index high-cardinality fields (e.g., `req_id`, `trace_id`) as
  Loki **labels** — use structured metadata instead (as shown above) to avoid
  cardinality explosion.
