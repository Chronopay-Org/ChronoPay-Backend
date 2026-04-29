# API Error Format

## Validation errors

All validation failures return HTTP **400** with a stable JSON envelope.

### Shape

```json
{
  "success": false,
  "code": "VALIDATION_ERROR",
  "error": "One or more fields failed validation",
  "details": [
    {
      "path": "endTime",
      "rule": "required",
      "message": "endTime is required"
    },
    {
      "path": "professional",
      "rule": "required",
      "message": "professional is required"
    }
  ]
}
```

### Fields

| Field | Type | Description |
|---|---|---|
| `success` | `false` | Always `false` on error |
| `code` | `string` | Stable machine-readable code clients can `switch` on |
| `error` | `string` | Human-readable summary |
| `details` | `ValidationDetail[]` | One entry per failing field |

### `ValidationDetail`

| Field | Type | Description |
|---|---|---|
| `path` | `string` | Field name (e.g. `"startTime"`) |
| `rule` | `string` | Rule that failed (e.g. `"required"`) |
| `message` | `string` | Human-readable description — never contains the raw value |

### Ordering guarantee

`details` is always sorted **lexicographically by `path` ascending, then by `rule` ascending**. This ordering is deterministic across all Node.js versions and locales.

Clients can rely on this ordering for rendering and snapshot tests.

### Known `code` values

| Code | HTTP status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | One or more fields failed validation |
| `INTERNAL_ERROR` | 500 | Unexpected middleware failure |

### Security guarantees

- Raw field **values** are never included in any error response.
- Messages reference only the field **name** (which comes from the
  server-side schema, not from user input).
- Whitespace-only values are treated as missing.

## Feature-disabled errors

When a feature flag is off, the affected endpoint returns HTTP **503**:

```json
{
  "success": false,
  "code": "FEATURE_DISABLED",
  "error": "Feature CREATE_SLOT is currently disabled"
}
```

## Rate limit errors

When the per-IP rate limit is exceeded the API returns HTTP **429**:

```json
{
  "success": false,
  "error": "Too many requests, please try again later."
}
```