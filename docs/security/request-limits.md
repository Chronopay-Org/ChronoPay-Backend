# Per-Route Request Payload Size Limits

Enforces body size limits before deep JSON parsing to reduce attack surface on high-risk endpoints.

## Overview

`src/middleware/payloadLimit.ts` provides a `payloadLimit(limit)` middleware factory that:

1. Re-parses the raw request body with the given size limit, overriding any global limit set earlier in the middleware chain.
2. Returns a `413 Payload Too Large` response with the standard error envelope when the limit is exceeded.
3. Propagates other parser errors (malformed JSON, etc.) to the next error handler.

## Route limits

| Route | Limit | Rationale |
|---|---|---|
| `POST /api/v1/checkout/sessions` | `16kb` | Tight limit reduces attack surface for payment endpoints |
| `POST /api/v1/slots` | `32kb` | Moderate limit for slot creation |
| All other routes | `100kb` | Global default set via `express.json({ limit })` in `app.ts` |

These values are centralised in `ROUTE_PAYLOAD_LIMITS` in `src/middleware/payloadLimit.ts`.

## Usage

```ts
import { payloadLimit, ROUTE_PAYLOAD_LIMITS } from "../middleware/payloadLimit.js";

// Apply to a specific route
router.post("/sessions", ...payloadLimit(ROUTE_PAYLOAD_LIMITS.checkout), handler);

// Or with a custom limit
router.post("/upload", ...payloadLimit("512kb"), handler);
```

## 413 response shape

```json
{
  "success": false,
  "code": "PAYLOAD_TOO_LARGE",
  "error": "Request body exceeds the 16kb limit for this endpoint."
}
```

## Security notes

- Limits are enforced **before** any application logic runs — the body is rejected at the network layer, not after allocation.
- Size strings are validated at module load time; misconfigured limits cause a startup error rather than a silent bypass.
- Supported size units: `b`, `kb`, `mb`. Format: `<positive-integer><unit>` (e.g. `16kb`, `1mb`, `512b`).

## Test coverage

`src/__tests__/payloadLimit.test.ts` covers valid/invalid size strings, 413 response shape, boundary conditions, and the `ROUTE_PAYLOAD_LIMITS` registry.
