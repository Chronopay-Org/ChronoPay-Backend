# chronopay-backend

API backend for **ChronoPay** - time tokenization and scheduling marketplace on Stellar.

## What's in this repo

- **Express** API with TypeScript
- Health, slot, and booking-intent routes
- Ready for Stellar Horizon integration, token service, and scheduling logic

## Prerequisites

- Node.js 20+
- npm
- Docker 20.10+ (optional, for containerized development)
- Docker Compose 2.0+ (optional, for containerized development)

## Setup

```bash
# Clone the repo (or use your fork)
git clone <repo-url>
cd chronopay-backend

# Setup (choose one):

# Configure environment variables
cp .env.example .env
# Edit .env and set JWT_SECRET to a strong random value

# Build
npm run build
npm test
npm run dev    # Start dev server with hot reload

## Option 2: Docker Development (requires Docker)
# Copy environment file
cp .env.example .env

# Using helper script
./scripts/docker-health.sh start

# Or using docker-compose directly
docker-compose up -d --build

# View logs
docker-compose logs -f

# Run tests in container
./scripts/docker-health.sh test
```

## Environment validation

ChronoPay validates environment variables centrally at startup through `src/config/env.ts`.

Currently validated variables used by `src`:

- `NODE_ENV`
  - optional
  - default: `development`
  - allowed: `development`, `test`, `production`
- `PORT`
  - optional
  - default: `3001`
  - must be an integer in the range `1` to `65535`

### Startup failure behavior

If configuration is invalid, the app fails fast before serving requests. Errors are aggregated and sanitized so they identify variable names and reasons without echoing raw values.

Example:

```text
Invalid environment configuration:
- NODE_ENV must be one of: development, test, production.
- PORT must be a whole number between 1 and 65535.
```

### Security notes

- no partial startup on invalid configuration
- whitespace-only values are rejected
- numeric parsing is strict
- no raw env values are leaked in validation errors

Additional reviewer-focused notes live in:

- `docs/environment-validation.md`

## Scripts

| Script | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Run production server |
| `npm run dev` | Run dev server with tsx watch |
| `npm test` | Run Jest tests |
| `npm run migrate` | Database migration CLI (see below) |

## Database Migrations

ChronoPay includes a migration framework with drift detection and safety checks.

### Quick Commands

```bash
# Check migration status
npm run migrate status

# Validate migrations (no DB needed)
npm run migrate validate

# Check for drift and naming issues
npm run migrate drift-check

# Apply pending migrations
npm run migrate up

# Roll back last migration
npm run migrate down
```

### Drift Detection

Before deploying to any environment, run drift check to ensure schema consistency:

```bash
npm run migrate drift-check
```

This detects:
- Orphaned migrations (applied but not in registry)
- Name mismatches between code and database
- Out-of-order application
- Naming convention violations

See [docs/database/migrations.md](docs/database/migrations.md) for complete documentation.

## API (slot listing)

- `GET /health` — Health check; returns `{ status: "ok", service: "chronopay-backend" }`
- `GET /api/v1/slots` — List time slots with pagination
  - Query parameters:
    - `page` (integer, default `1`, min `1`)
    - `limit` (integer, default `10`, min `1`, max `100`)
  - Response:
    - `{ data: Slot[], page, limit, total }`
  - Error responses:
    - `400` for invalid page/limit
    - `500` for backend errors
  - Example:
    - `/api/v1/slots?page=2&limit=5`

## Rate Limiting

ChronoPay Backend implements **auth-aware rate limiting** to ensure fair usage while minimizing collateral damage from shared IP addresses (NAT, corporate proxies). The limiter keys requests by authenticated principal (user ID or API key) when available, and falls back to IP for unauthenticated traffic.

### Key Strategy

Priority order for rate-limit key generation:

1. **Header-based user ID** (`x-chronopay-user-id`) → `rl:user:<userId>`
2. **JWT user ID** (`req.user.sub` or `req.user.id`) → `rl:user:<userId>`
3. **API key** (SHA-256 hash of `x-api-key`) → `rl:apiKey:<hash>`
4. **IP address** (`req.ip`, respects `TRUST_PROXY`) → `rl:ip:<ip>`

This ensures:
- Different principal types never collide
- Same principal shares quota across all protected routes (global counter)
- Unauthenticated requests are still limited by IP

### Default Limits

| Setting       | Default    | Description                           |
|---------------|------------|---------------------------------------|
| Window        | 15 minutes | Rolling window per principal         |
| Max requests  | 100        | Per principal within the window      |
| Response code | `429`      | HTTP status when limit exceeded       |

### Configuration

Override with environment variables:

| Variable               | Default | Description                                  |
|------------------------|---------|----------------------------------------------|
| `RATE_LIMIT_WINDOW_MS` | `900000`| Window duration in milliseconds              |
| `RATE_LIMIT_MAX`       | `100`   | Max requests per window per principal        |
| `TRUST_PROXY`          | `false` | Use `X-Forwarded-For` for client IP behind load balancer |

All authenticated endpoints should apply `createAuthAwareRateLimiter()` **after** their authentication middleware. Unauthenticated endpoints (e.g., health checks) are automatically IP-based if a limiter is used.

### 429 Response

```json
{
  "success": false,
  "error": "Too many requests, please try again later."
}
```

Every response also includes the `RateLimit` header (draft-7 format):

```
RateLimit: limit=100, remaining=85, reset=1711072800
```

### Middleware Usage

**Header-based auth** (`x-chronopay-user-id`):
```ts
router.post(
  '/',
  requireAuthenticatedActor(['customer', 'admin']),
  createAuthAwareRateLimiter(),
  handler
);
```

**API-key auth** (`x-api-key`):
```ts
router.post(
  '/',
  requireApiKey(process.env.API_KEY),
  createAuthAwareRateLimiter(),
  handler
);
```

**JWT auth** (Bearer token):
```ts
router.get(
  '/profile',
  authenticate,
  createAuthAwareRateLimiter(),
  handler
);
```

### Trust Proxy

When running behind a reverse proxy or load balancer, set `TRUST_PROXY=true`. Express will then derive `req.ip` from `X-Forwarded-For`. **Do not enable** if the API is directly exposed; clients could spoof their IP and bypass rate limits.

### Security Notes

- **Auth-before-rate-limit**: The rate limiter must be placed **after** authentication middleware; otherwise it falls back to IP-based keys.  
- **Header trust**: Header-based auth assumes a trusted upstream validates `x-chronopay-user-id`. Direct exposure without a gateway allows spoofing.  
- **API key hashing**: Raw API keys are never stored; Redis keys contain only SHA-256 hashes.  
- **Redis**: All instances share a single Redis store (`rl:` namespace). Ensure Redis is not publicly accessible.

### Full documentation

See [`docs/rate-limiting.md`](docs/rate-limiting.md) for deep dive, troubleshooting, and observability details.

## Feature Flags

ChronoPay backend uses environment-driven feature flags for safe rollout and rapid disable.
For the enforced registry and guarded-route mapping, see [`docs/feature-flags.md`](docs/feature-flags.md).

### Configuration

- Flag env format: `FF_<FLAG_NAME>`
- Initial flags:
	- `FF_CREATE_SLOT` controls `POST /api/v1/slots`

Supported values (case-insensitive):

- Enabled: `true`, `1`, `on`, `yes`
- Disabled: `false`, `0`, `off`, `no`

If a flag env variable is missing, the service uses the registered default value.

### Runtime behavior

- `POST /api/v1/slots` when `FF_CREATE_SLOT=true`: route behaves normally.
- `POST /api/v1/slots` when `FF_CREATE_SLOT=false`: returns `503` and:

```json
{
	"success": false,
	"code": "FEATURE_DISABLED",
	"error": "Feature CREATE_SLOT is currently disabled"
}
```

- `GET /health` and `GET /api/v1/slots` are unaffected by this flag.

### Failure-mode handling

- Missing flag env var: falls back to default.
- Malformed flag value: service fails at startup with explicit configuration error.
- Unknown flag lookup in code path: treated as server misconfiguration and rejected.

### Quick local examples

```bash
# Enable slot creation
FF_CREATE_SLOT=true npm run dev

# Disable slot creation (POST returns 503)
FF_CREATE_SLOT=false npm run dev
```

### Acceptance criteria

- Feature flags are validated at startup with strict allowed values.
- Guarded endpoint responds with deterministic `503` payload when disabled.
- Unguarded endpoints keep current behavior.
- Automated tests cover enabled, disabled, and malformed-config paths.

## Contributing

1. Fork the repo and create a branch from `main`.
2. Install deps and run tests: `npm install && npm test`.
3. Make changes; keep the build passing: `npm run build`.
4. Open a pull request. CI must pass (install, build, test).

## CI/CD

On every push and pull request to `main`, GitHub Actions runs:

- **Install**: `npm ci`
- **Build**: `npm run build`
- **Tests**: `npm test`

## Environment Variables

| Variable    | Required | Description |
|-------------|----------|-------------|
| `REDIS_URL` | Yes      | Redis connection URL used for idempotency key storage |

```env
REDIS_URL=redis://localhost:6379
```

> Idempotency keys are stored in Redis with a 24-hour TTL. Without Redis the server will start, but idempotency-protected endpoints (`POST /api/v1/slots`) will fail.

## License

MIT
