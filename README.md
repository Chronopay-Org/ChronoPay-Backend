# chronopay-backend

API backend for **ChronoPay** - time tokenization and scheduling marketplace on Stellar.

## What's in this repo

- **Express** API with TypeScript
- Health, slot, and booking-intent routes
- Ready for Stellar Horizon integration, token service, and scheduling logic

## Prerequisites

- Node.js 20+
- npm

## Setup

```bash
# Clone the repo (or use your fork)
git clone <repo-url>
cd chronopay-backend

# Install dependencies
npm install

# Configure environment variables
cp .env.example .env
# Edit .env and set JWT_SECRET to a strong random value

# Build
npm run build

# Run tests
npm test

# Start dev server (with hot reload)
npm run dev

# Start production server
npm run start
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

## License

MIT
