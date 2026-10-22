# ChronoPay Backend

REST API for **ChronoPay**, a time-tokenization and scheduling marketplace on Stellar. Suppliers publish time slots, buyers create booking intents and checkout sessions, and settlement/escrow state is tracked against Stellar (Horizon) and an escrow contract.

- Frontend: [Chronopay-Org/ChronoPay-Frontend](https://github.com/Chronopay-Org/ChronoPay-Frontend)
- Contracts: [Chronopay-Org/ChronoPay-Contracts](https://github.com/Chronopay-Org/ChronoPay-Contracts)

## Architecture

Node.js (ESM) + TypeScript + Express 4. Entry point `src/index.ts` builds the app from `src/app.ts` (`createApp`) and listens on `PORT` (default `3001`).

| Area | Location |
| --- | --- |
| Routers (HTTP surface) | `src/routes/`, `src/buyer-profile/` |
| Business logic | `src/services/`, `src/modules/`, `src/scheduler/` |
| Persistence | `src/db/` (pg pool, migration runner, drift detector), `src/repositories/` |
| Redis (idempotency, caching, rate limits) | `src/cache/`, `src/lib/` |
| Stellar / escrow clients | `src/clients/`, `src/stellar/` |
| Cross-cutting middleware | `src/middleware/` (auth, RBAC, CORS, rate limit, validation, error envelope) |
| Observability | `src/metrics/`, `src/tracing/`, pino logging, `ops/` (alert rules, dashboards) |
| Config validation | `src/config/env.ts` (fails fast on invalid env) |

Other dependencies in `package.json`: ethers, `@stellar/stellar-sdk`, zod, prom-client, ioredis, KMS clients (AWS/GCP), swagger-ui-express.

## API surface

All business routes are under `/api/v1`. Interactive docs are served at `/api-docs` and the generated spec is in `openapi-spec.json` (`npm run generate-openapi`). The list below is derived from the router files; consult the OpenAPI spec and `docs/api/` for request/response shapes.

**Operational (unversioned):** `GET /health`, `/health/horizon`, `/health/ready`, `/ready`, `/live`, `/metrics`.

**Slots:** `GET /api/v1/slots`, `POST /api/v1/slots`, `DELETE /api/v1/slots/:id` (plus per-id read/patch in `src/routes/slots.ts`).

**Booking intents** (`/api/v1/booking-intents`): `POST /`, `GET /`, `GET /:id`, `POST /:id/confirm`, `/:id/cancel`, `/:id/refund`, `/:id/no-show`, `GET /:id/cancel-preview`, `GET /:id/hold-status`, `POST /:id/auto-refund-hold`.

**Checkout** (`/api/v1/checkout`): `POST /sessions`, `GET /sessions/:sessionId`, `POST /sessions/:sessionId/{complete,pay,fail,cancel}`.

**Buyer profiles** (`/api/v1/buyer-profiles`): create, read (several lookups), `PATCH`, `DELETE`.

**Auth:** `POST /api/v1/auth/verify`; OAuth2 `GET /api/v1/auth/oauth/:provider/start` and `/callback`. TOTP MFA is supported (see env vars).

**Subscriptions** (`/api/v1/subscriptions`): product CRUD under `/products`, subscription create/get/list, `POST /:id/{pause,resume,cancel}`.

**Webhooks:** `POST /api/v1/webhooks/settlements`, `POST /api/v1/webhooks/kyc` (signature-verified), admin idempotency inspection/sweep.

**Other:** `GET /api/v1/suppliers/:supplierId/reputation/signals`, `GET /api/v1/partner/quota`, `POST /api/v1/gdpr/export` + `GET .../download`, GraphQL (`POST` in `src/routes/graphql.ts`), `POST /api/v1/notifications/sms`.

**Admin** (`/api/v1/admin`, token/role protected): audit export, webhook secret rotation, refunds, payment trace, fraud human-in-the-loop queue, escrow pause, disputes (evidence, adjudicate, appeal, deadline scan), holiday calendars, buyer strikes, grace windows per slot category, cancellation overrides, access reviews, GDPR DSR management, legal holds, redaction policy, fraud model registry (`/fraud-models`), feature-flag rollouts (`/flag-rollouts`), supplier reputation snapshots.

## Configuration

Copy `.env.example` to `.env`. Variables listed there:

| Variable | Purpose |
| --- | --- |
| `JWT_SECRET` | JWT signing secret (>= 32 random chars) |
| `PORT` | Listen port (default 3001) |
| `CORS_ALLOWED_ORIGINS` | Comma-separated origins; must be set explicitly in production |
| `IDEMPOTENCY_REDIS_ENCRYPTION_ENABLED`, `_ACTIVE_KEY_ID`, `_ACTIVE_KEY`, `_PREVIOUS_KEYS` | Optional AES-256-GCM encryption of idempotency payloads in Redis, with key rotation |
| `MFA_ENCRYPTION_KEY`, `MFA_CHALLENGE_SECRET` | Required for MFA endpoints |
| `MFA_ISSUER`, `MFA_FRESHNESS_MS`, `MFA_WINDOW_PERIODS`, `MFA_CHALLENGE_TTL_SEC` | Optional MFA tuning |

`src/config/env.ts` additionally reads (not all in `.env.example`): `NODE_ENV`, `REDIS_URL` (required), `HORIZON_URL`/`HORIZON_URLS`, `STELLAR_NETWORK_PASSPHRASE`, `ESCROW_CONTRACT_HASH`, `JWT_ISSUER`, `JWT_AUDIENCE`, `WEBHOOK_SECRET`, `INTERNAL_OVERRIDE_SECRET(_PREV)`, `INTERNAL_BYPASS_TOLERANCE_MS`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `REQUEST_TIMEOUT_MS`, `TRUST_PROXY`. See [docs/environment-validation.md](docs/environment-validation.md) for validation rules. A database connection is configured in `src/db/` (see [docs/database/migrations.md](docs/database/migrations.md)).

### Checkout redirect destinations (#1325)

Optional `successUrl` and `cancelUrl` are checked by the checkout request
validator before session creation. Each must be an absolute URL of at most 2048
characters, use HTTPS in production (HTTP is also allowed outside production),
and match an exact configured URL host, including a non-default port if present.
Credentials, raw whitespace/backslashes, relative URLs and non-HTTP schemes are
rejected. Query strings and fragments on approved destinations are preserved.

Set `CHECKOUT_REDIRECT_ALLOWED_HOSTS=app.example,checkout.example:8443` (host
authorities only, no schemes, paths or wildcard/subdomain patterns). When this
variable is absent, the host of a valid absolute `APP_URL` is the fallback.
An explicitly empty/invalid list denies supplied redirects rather than falling
back. Without either valid configuration, supplied redirects are rejected;
requests omitting both optional fields remain valid. Invalid destinations return
400 with the existing checkout envelope, `code: INVALID_REDIRECT_URL` and
`details.field: successUrl|cancelUrl`, without reflecting the URL. This policy
does not change checkout authentication, payments or direct service callers.

## Running locally

Requires Node.js 20+ (CI uses 22), npm, and a Redis instance.

```bash
cp .env.example .env     # set JWT_SECRET, REDIS_URL, etc.
npm ci
npm run dev              # tsx watch src/index.ts
# or
npm run build && npm start
```

Docker: `docker-compose.yml`, `docker-compose.override.yml` (dev) and `docker-compose.prod.yml` are provided, along with `scripts/docker-health.sh`.

Useful scripts: `npm run migrate <status|validate|drift-check|up|down>`, `npm run generate-openapi`, `npm run generate:error-docs`, `npm run pii-scan`, `npm run sbom`, `npm run canary`, `npm run lint`, `npm run typecheck`.

### Graceful shutdown

The executable handles `SIGTERM` and `SIGINT` with one shared shutdown sequence.
It stops accepting HTTP connections and stops background workers, waits for
existing HTTP requests, then closes both PostgreSQL pools and the slot-cache
Redis client. Worker initializers that finish importing after shutdown starts
do not start new work. Importing the entry point under `NODE_ENV=test` neither
binds a port nor installs process signal handlers.

`SHUTDOWN_TIMEOUT_MS` is a positive integer (default `30000`, at most `2147483647`)
covering worker stops, HTTP draining and resource closure. At the deadline,
remaining HTTP connections are forcibly closed and resource cleanup is attempted;
a signal-triggered shutdown exits unsuccessfully on timeout/close failure.
The signal handler has a hard exit fallback if cleanup never resolves. Ordinary
shutdown exits with code 0. Driver/worker failures are logged with structured
resource names without request or credential contents. Already-running external
calls remain subject to their worker's existing cancellation support and the
shutdown deadline; this does not redesign those workers or merge the DB pools.

## Testing

`npm test` runs Jest (ESM, in-band); `npm run test:coverage` adds coverage. Most tests live in `src/**/__tests__/`, with mocks and Pact contract tests under `test/`. See `docs/testing/` for database, Redis and contract test notes.

## CI and deployment

GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR to `main`: `npm ci` then `npm run build`. The `Dockerfile` is a multi-stage build producing a production image. `scripts/release-sdk.js` is a helper for OpenAPI-diff-driven SDK versioning (run with `--dry-run` to validate); the only workflow in the repo is the CI build above. Operational material: alert rules and dashboards in `ops/`, secret rotation in `docs/SECRET_ROTATION_RUNBOOK.md`, escrow migration in `docs/runbook/escrow-migration.md`.

## Documentation

See [docs/index.md](docs/index.md) for a categorized index of the design and operations docs. Root-level feature notes: `CHECKOUT_API.md`, `CHECKOUT_SECURITY.md`, `IMPLEMENTATION_NOTES.md`.

## License

No LICENSE file is present in the repository (an earlier README stated MIT).
