# PII Redaction in Logger

> **Issue:** [#593 – Add PII-redaction transformer to logger for booking payloads](https://github.com/Chronopay-Org/ChronoPay-Backend/issues/593)

## Overview

The application logger (`src/utils/logger.ts`) uses **pino's built-in `redact`
option** to strip buyer PII from every log line before it is written to stdout
or any downstream log store. The fields are **removed entirely** (`remove: true`)
rather than replaced with a censor string — no placeholder value ever reaches
a log aggregator.

---

## Redacted paths

| Path | Payload context |
|---|---|
| `buyer.name` | Top-level booking-intent payload |
| `buyer.email` | Top-level booking-intent payload |
| `buyer.phone` | Top-level booking-intent payload |
| `buyers[*].name` | Bulk-intent arrays |
| `buyers[*].email` | Bulk-intent arrays |
| `buyers[*].phone` | Bulk-intent arrays |
| `intent.buyer.name` | Nested intent wrapper |
| `intent.buyer.email` | Nested intent wrapper |
| `intent.buyer.phone` | Nested intent wrapper |
| `booking.buyer.name` | Nested booking wrapper |
| `booking.buyer.email` | Nested booking wrapper |
| `booking.buyer.phone` | Nested booking wrapper |

Existing header / credential paths (`headers.authorization`, `body.password`,
etc.) remain in the same redact config and are unaffected by this change.

---

## Design decisions

### Why `remove: true` instead of a censor string?

A censor like `"[REDACTED]"` is still a string value that travels through the
log pipeline. Any misconfigured downstream processor could forward it, and the
presence of the key itself reveals that PII was once there. Removing the key
entirely eliminates both risks.

### Why pino `redact` instead of the `sanitizeForLogging` helper?

`sanitizeForLogging` operates on arbitrary key names via a `Set` lookup. It is
well-suited for catching unknown/dynamic keys such as `password` or `secret`
across any object shape. However it is applied inside the `formatters.log`
hook, which runs **after** serialisation — meaning very large objects are
already deep-cloned.

Pino's `redact` option uses a compiled path-expression engine (powered by
`fast-redact`) that operates at **serialisation time** with near-zero overhead
and supports wildcard array traversal (`buyers[*]`). For a well-known,
schema-stable payload shape like booking intents, explicit path-based redaction
is both more efficient and more explicit about intent.

Both mechanisms are active; they complement each other.

### Why these three fields?

`BuyerProfile` exposes `fullName`, `email`, and `phoneNumber` in the database
model. The booking-intent log shape uses the shorter form (`name`, `email`,
`phone`) matching the API request/response contract. All three qualify as PII
under GDPR Article 4(1) and CCPA.

---

## Testing

Tests live in:

```
src/utils/__tests__/logger-pii-redact.test.ts
```

The suite builds an isolated pino instance writing to an in-memory stream and
covers:

- Top-level `buyer` object: all three PII fields removed, structural fields
  (`id`, `tier`, …) preserved.
- `buyers[*]` array: every element is stripped.
- Nested `intent.buyer` and `booking.buyer` paths.
- Edge cases: partial payload (only one PII field present), `buyer: null`,
  `buyer: undefined`, non-string `phone` value, and an unrelated field named
  `phonetics` to confirm exact-path matching.

Run the suite:

```bash
npm test -- --testPathPattern logger-pii-redact
```

---

## Security assumptions and limitations

1. **Path-exact matching.** Pino `redact` matches the literal dot-notation
   paths listed. A payload that wraps the buyer under a differently named key
   (e.g. `customer.email`) is **not** covered by these paths. Add new paths if
   the API schema evolves.

2. **Depth limit.** Wildcard traversal (`[*]`) applies one level deep. Nested
   arrays of buyers inside arrays are not handled — this is not currently a
   supported payload shape.

3. **Serialisation boundary.** Redaction happens at serialisation time inside
   pino. Any code that logs a pre-serialised string (e.g. `JSON.stringify`) and
   passes it as the message bypasses redaction. Always pass objects as the
   first argument to pino log methods.

4. **Development pretty-print.** In development (`NODE_ENV=development`),
   `pino-pretty` is used for output. Redaction is applied before
   `pino-pretty` formats the line, so PII does not appear in the terminal
   either.

5. **No persistence of PII in error payloads.** If an error object carries a
   `buyer` property, the pino `serializers.error` handler serialises it before
   the `redact` paths are applied. Ensure error objects do not embed raw buyer
   data.

---

## Related documentation

- [`docs/database/observability.md`](../database/observability.md) – slow-query
  logging and the same "no query parameters in logs" principle.
- [`docs/pii-conformance.md`](../pii-conformance.md) – PII conformance scanning
  script.
- [`docs/gdpr-erasure.md`](../gdpr-erasure.md) – GDPR erasure flow.
