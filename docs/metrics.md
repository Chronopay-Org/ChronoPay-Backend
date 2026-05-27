# Slot Service Metrics

Structured counters and histograms for slot operations with strict cardinality controls.

## Overview

`src/metrics/slotMetrics.ts` exposes a lightweight in-process metrics registry (no external dependency) that tracks:

| Metric | Type | Description |
|---|---|---|
| `slot_operation_count` | Counter | Slot operation invocations keyed by `operation` × `outcome` |
| `slot_list_latency_ms` | Histogram | End-to-end latency of `listSlots()` in milliseconds |
| `slot_cache_status` | Counter | Cache interactions keyed by `hit`, `miss`, or `bypass` |

## Cardinality controls

Labels are restricted to a fixed, bounded set of values — no user IDs, no raw route parameters, no free-form strings are ever used as label values.

| Label | Allowed values |
|---|---|
| `operation` | `list`, `create`, `update`, `delete` |
| `outcome` | `success`, `error` |
| `cache_status` | `hit`, `miss`, `bypass` |

## Integration

`slotService.listSlots()` automatically records:

1. `recordSlotOperation("list", "success" | "error")` — after every call.
2. `recordListLatency(durationMs)` — wall-clock time from entry to return/throw.

Cache-layer code calls `recordCacheStatus(status)` when it resolves a slot-list cache lookup.

## API

```ts
import {
  recordSlotOperation,
  recordListLatency,
  recordCacheStatus,
  getSlotMetricsSnapshot,
  resetSlotMetrics,
} from "./metrics/slotMetrics.js";

// Record an operation outcome
recordSlotOperation("list", "success");

// Record list latency
recordListLatency(42); // ms

// Record cache interaction
recordCacheStatus("hit");

// Read current values (returns a deep copy — safe to mutate)
const snap = getSlotMetricsSnapshot();

// Reset all counters (test isolation only)
resetSlotMetrics();
```

## Histogram buckets (ms)

`5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000`

## Security notes

- No user data or request-scoped identifiers are ever used as label values.
- `resetSlotMetrics()` is intended for test isolation only; do not call it in production code.
- The registry is a plain singleton object — no external metrics server is required.

## Test coverage

`src/__tests__/slotMetrics.test.ts` covers all public functions including edge cases (NaN, negative, Infinity latency values) and singleton reset behaviour.
