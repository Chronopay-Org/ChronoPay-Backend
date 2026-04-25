# Outbound Call Reliability: Timeouts and Retries

This document outlines the reliability policies for all outbound calls (Blockchain RPC, SMS Providers, Webhooks) in the ChronoPay backend.

## Overview

To prevent hanging I/O and ensure system stability, every outbound call must be:
1.  **Bounded**: Have an explicit timeout.
2.  **Abortable**: Use `AbortController` to cancel requests.
3.  **Budgeted**: Retries must respect a total time budget.
4.  **Logged**: Include `requestId` and service identification.

## Configuration

Timeouts and retries are configured in `src/config/timeouts.ts`.

### Default Values

| Integration | Timeout (ms) | Env Var |
| :--- | :--- | :--- |
| Default HTTP | 5,000 | `TIMEOUT_HTTP_DEFAULT_MS` |
| Blockchain RPC | 7,000 | `TIMEOUT_HTTP_CONTRACT_MS` |
| SMS Providers | 5,000 | `TIMEOUT_HTTP_SMS_MS` |
| Webhooks | 4,000 | `TIMEOUT_HTTP_WEBHOOK_MS` |

### Retry Policy

| Parameter | Default | Env Var |
| :--- | :--- | :--- |
| Max Attempts | 3 | `RETRY_MAX_ATTEMPTS` |
| Base Delay | 200 ms | `RETRY_BASE_DELAY_MS` |
| Total Budget | 8,000 ms | `RETRY_MAX_TOTAL_BUDGET_MS` |

Retries use **Exponential Backoff**: `baseDelay * 2^(attempt - 1)`.

## Error Mapping

All outbound errors are mapped to stable internal error classes:

| Internal Error | HTTP Status | Description |
| :--- | :--- | :--- |
| `OutboundTimeoutError` | 504 | Request timed out. |
| `OutboundUnavailableError` | 503 | Retries exhausted or service down. |
| `OutboundBadResponseError` | 502 | Non-retryable error (e.g., 4xx). |

## Implementation Helpers

### `withTimeout`

Wraps a function with an `AbortController`.

```typescript
import { withTimeout } from "../utils/outbound-helper.js";

const result = await withTimeout(
  async (signal) => {
    return await fetch(url, { signal });
  },
  5000,
  "service-name"
);
```

### `withRetry`

Handles retries with exponential backoff and a total budget.

```typescript
import { withRetry, withTimeout } from "../utils/outbound-helper.js";

const result = await withRetry(
  async (attempt) => {
    return await withTimeout(
      async (signal) => callApi(signal),
      5000,
      "service-name"
    );
  },
  { serviceName: "service-name" }
);
```

## Logging

Every outbound attempt logs the following structured data:
- `requestId`: Current trace ID.
- `service`: Logical name of the service.
- `attempt`: Current attempt number.
- `duration`: Time taken for the attempt.
- `outcome`: success/timeout/error.

**Security Note**: Raw upstream URLs are NEVER logged. Logical service names are used instead.

## Operational Notes

- **Tightening Webhooks**: If a webhook receiver is slow, consider lowering `TIMEOUT_HTTP_WEBHOOK_MS` to avoid blocking internal workers.
- **Budget Monitoring**: If `outbound_budget_exceeded` appears frequently in logs, increase `RETRY_MAX_TOTAL_BUDGET_MS` or investigate upstream latency.
