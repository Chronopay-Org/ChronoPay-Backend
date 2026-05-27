# Tracing Conventions

ChronoPay uses **AsyncLocalStorage**-based distributed tracing. Spans are
lightweight in-process records; no external collector is required to run the
service, but one can be plugged in via the exporter API.

## Architecture

```
Request
  └─ tracingMiddleware          (creates root TraceContext in AsyncLocalStorage)
       └─ route handler
            └─ withSpan(...)    (creates child span, propagates context)
                 └─ service method
                      └─ withSpan(...)   (nested child span)
```

### Key modules

| File | Purpose |
|---|---|
| `src/tracing/context.ts` | `TraceContext`, `AsyncLocalStorage`, `runWithTraceContext`, `createChildContext` |
| `src/tracing/middleware.ts` | `tracingMiddleware` — extracts/generates trace headers, seeds root context |
| `src/tracing/hooks.ts` | `withSpan` — wraps work in a child span; `getCurrentSpan` |
| `src/tracing/spanExporter.ts` | `addSpanExporter` / `removeSpanExporter` / `emitSpan` — pluggable sink |
| `src/tracing/index.ts` | Barrel re-export of all public symbols |

## HTTP headers

| Header | Direction | Purpose |
|---|---|---|
| `x-trace-id` | in + out | Identifies the full request path across services |
| `x-span-id` | out | Identifies the root span for this service |
| `x-parent-span-id` | in | Caller's span ID (for cross-service linking) |

## Span naming convention

Use `<domain>.<operation>` in lower-case:

```
slots.create
slots.update
slots.list
checkout.createSession
checkout.getSession
checkout.completeSession
checkout.cancelSession
bookingIntents.create
```

## Stable span attributes

Every span records these attributes automatically via `withSpan`:

| Attribute | Type | Description |
|---|---|---|
| `route` | string | HTTP method + path template, e.g. `POST /api/v1/slots` |
| `outcome` | `"ok"` \| `"error"` | Whether the operation succeeded |
| `latency` | number | Duration in milliseconds |
| `error` | boolean | Present and `true` only on failure |
| `error.message` | string | Sanitised error message (no stack trace) |

Additional domain-specific attributes (e.g. `slotId`, `paymentMethod`) may be
added when they are **not PII**.

## Security rules — what must NOT appear in span attributes

- Email addresses, phone numbers, names
- Customer IDs, user IDs, session tokens
- Payment card numbers, bank account details
- Any value derived from user-supplied free-text

If you need to correlate a span with a user for debugging, use the `requestId`
(from `x-request-id`) which is already present in logs.

## Adding a span

```typescript
import { withSpan } from "../tracing/index.js";

// In a service method:
async function doWork(input: Input): Promise<Result> {
  return withSpan("domain.operation", { route: "POST /api/v1/resource" }, async () => {
    // ... your logic
  });
}
```

`withSpan` automatically:
- Creates a child `TraceContext` linked to the current parent
- Records `outcome`, `latency`, `error`, `error.message`
- Emits the span to all registered exporters

## Plugging in a span exporter

```typescript
import { addSpanExporter, removeSpanExporter } from "../tracing/index.js";
import type { Span } from "../tracing/index.js";

const myExporter = (span: Span) => {
  // send to your collector
};

addSpanExporter(myExporter);
// later:
removeSpanExporter(myExporter);
```

Exporters must not throw — any exception is silently swallowed to protect the
request path.

## Enabling debug logging

Set `DEBUG_TRACING=true` to print every span to stdout:

```bash
DEBUG_TRACING=true npm run dev
```

## Propagating context to outbound calls

Use `getPropagationHeaders()` to forward the current trace context:

```typescript
import { getPropagationHeaders } from "../tracing/index.js";

const headers = getPropagationHeaders();
// { "x-trace-id": "...", "x-parent-span-id": "..." }
await fetch(upstreamUrl, { headers: { ...headers } });
```

## Testing

Use `addSpanExporter` / `removeSpanExporter` to capture spans in tests:

```typescript
import { addSpanExporter, removeSpanExporter } from "../tracing/index.js";
import type { Span } from "../tracing/index.js";

const spans: Span[] = [];
const exporter = (s: Span) => spans.push(s);
addSpanExporter(exporter);

// ... exercise code under test ...

removeSpanExporter(exporter);
expect(spans[0].attributes.outcome).toBe("ok");
```

See `src/__tests__/tracing-spans.test.ts` for full examples.
