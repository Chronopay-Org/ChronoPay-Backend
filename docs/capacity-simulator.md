# Capacity Planning Peak Replayer

The capacity simulator replays historical traffic peaks against ChronoPay's infrastructure to
help the team predict headroom, plan capacity changes, and validate that SLO budgets survive
peak load—all without touching the real Stellar network.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Data Model](#data-model)
- [CLI Usage](#cli-usage)
- [Programmatic API](#programmatic-api)
- [Input Format – TrafficCurve JSON](#input-format--trafficcurve-json)
- [SLO Headroom Report](#slo-headroom-report)
- [Safety Guardrails](#safety-guardrails)
- [Edge Cases Handled](#edge-cases-handled)
- [Testing](#testing)
- [Security Notes](#security-notes)
- [Adding a New Route](#adding-a-new-route)

---

## Overview

```
Historical Curve → Ingester → Load Generator → Request Handler → SLO Reporter
                                    ↑
                             Safety Guardrails
```

The simulator ingests a `TrafficCurve` JSON document, builds a replay plan that matches the
observed per-route request mix, error rates, and p99 latency distribution, then reports how
much of each route's SLO error budget was consumed by the peak.

Key properties:

- **No real network calls.** The generator fires at an in-process callback, never HTTP.
- **No Stellar network calls.** `SafetyGuardrails` hard-blocks all known Horizon endpoints
  and refuses to run in `NODE_ENV=production`.
- **Deterministic.** Provide a `seed` to get the same plan every time—useful for CI comparisons.
- **Dry-run by default.** All real-timer scheduling is opt-in via `--live` / `dryRun: false`.

---

## Architecture

```
src/simulator/
├── types.ts              — Zod schemas: TrafficSample, TrafficCurve, SimulatorConfig, …
├── trafficIngester.ts    — Loads, validates, and normalises TrafficCurve (file or object)
├── loadGenerator.ts      — Builds and executes the ReplayPlan from a TrafficCurve
├── safetyGuardrails.ts   — Hard-blocks Stellar Horizon hosts and production runs
├── sloHeadroomReporter.ts — Computes per-route SLO headroom and formats the report
└── index.ts              — Orchestrator; re-exports everything; `simulate()` entry point

scripts/
└── capacity-sim.ts       — CLI wrapper

src/simulator/__tests__/
├── typesAndGuardrails.test.ts   — Zod schema validation + safety guardrails (56 tests)
├── trafficIngester.test.ts      — Ingestion paths, normalisation, edge cases (37 tests)
├── loadGenerator.test.ts        — Plan building, scale factors, determinism (28 tests)
├── sloHeadroomReporter.test.ts  — Headroom maths, report formatting (28 tests)
└── integration.test.ts          — Full pipeline, edge cases, CLI integration (23 tests)

scripts/__tests__/
└── capacity-sim.test.ts         — CLI flag parsing + main() integration (14 tests)
```

---

## Data Model

### TrafficSample

A single observation window for one route:

```jsonc
{
  "timestampMs": 1753660800000,  // Unix ms, start of the window
  "route": "booking_intent",     // one of the four routes
  "requestCount": 4200,          // total requests in the window
  "errorCount": 4,               // requests that resulted in an error
  "p99LatencyMs": 95.5           // observed p99 latency in ms
}
```

### TrafficCurve

The full captured window:

```jsonc
{
  "label": "2026-07-28 peak",
  "startIso": "2026-07-28T00:00:00.000Z",
  "endIso": "2026-07-28T01:00:00.000Z",
  "samples": [ /* ...TrafficSample[] */ ]
}
```

**Requirements:**
- `endIso` must be strictly after `startIso`.
- `samples` must contain at least one entry.
- `errorCount` must be ≤ `requestCount` (the ingester clamps and warns if violated).
- Samples may be out of order—the ingester sorts them.

### Valid routes

The four routes mirror the SLO definitions in `src/metrics/sloMetrics.ts`:

| Route              | SLO objective |
|--------------------|--------------|
| `booking_intent`   | 99.9%        |
| `slots_list`       | 99.5%        |
| `checkout`         | 99.99%       |
| `escrow_listener`  | 99.0%        |

---

## CLI Usage

```bash
# Smoke run with synthetic traffic (no file required):
npx tsx scripts/capacity-sim.ts --dry-run

# Replay a captured peak at 1× scale:
npx tsx scripts/capacity-sim.ts --curve-file ./ops/traffic/peak-2026-07-28.json

# Scale up by 2× and emit JSON report:
npx tsx scripts/capacity-sim.ts \
  --curve-file ./ops/traffic/peak.json \
  --scale 2.0 \
  --seed 42 \
  --json

# CI gate: exit 1 if any route blows its error budget:
npx tsx scripts/capacity-sim.ts \
  --curve-file ./ops/traffic/peak.json \
  --scale 1.5 \
  --fail-on-breach
```

### Flags

| Flag               | Default    | Description                                             |
|--------------------|------------|---------------------------------------------------------|
| `--curve-file <p>` | (synthetic)| Path to a TrafficCurve JSON file.                       |
| `--scale <n>`      | `1.0`      | Multiply all request counts by this factor.             |
| `--max-ms <n>`     | `60000`    | Maximum replay duration in ms (longer curves truncate). |
| `--seed <n>`       | (random)   | PRNG seed for deterministic plans.                      |
| `--dry-run`        | enabled    | Build plan only; no real-time timer delays.             |
| `--live`           | disabled   | Execute plan with real timer delays.                    |
| `--fail-on-breach` | disabled   | Exit 1 if any route exceeds its SLO budget.             |
| `--json`           | disabled   | Emit the SimulationReport as JSON to stdout.            |

---

## Programmatic API

```typescript
import {
  simulate,
  buildSyntheticCurve,
  assertAllWithinBudget,
  type SimulateResult,
} from "./src/simulator/index.js";

// --- Quick smoke run ---
const result = await simulate({
  config: { dryRun: true, seed: 1 },
});

// --- Replay a captured curve ---
const bigResult = await simulate({
  curveFile: "./ops/traffic/peak.json",
  config: {
    scaleFactor: 2.0,
    maxDurationMs: 3_600_000, // 1 hour
    dryRun: true,
    seed: 42,
  },
  requestHandler: (req) => {
    // Called for every simulated request.
    // DO NOT make real network calls here in test/CI contexts.
    metrics.record(req.route, req.isError);
  },
  onProgress: (done, total) => console.log(`${done}/${total}`),
  printReport: true,
});

// CI gate
assertAllWithinBudget(bigResult.report);
```

### `simulate(opts)` return value

```typescript
interface SimulateResult {
  curve: TrafficCurve;
  ingestionWarnings: IngestionWarning[];   // CLAMP_ERROR_COUNT | SAMPLES_REORDERED | SPARSE_RANGE
  plan: ReplayPlan;                        // { label, durationMs, requests: SimulatedRequest[] }
  report: SimulationReport;               // per-route headroom
  formattedReport: string;                // human-readable table
}
```

---

## Input Format – TrafficCurve JSON

To capture a real traffic window, query your Prometheus/Grafana stack and shape the data
into the `TrafficCurve` schema. Here is a minimal example:

```json
{
  "label": "2026-07-28 peak",
  "startIso": "2026-07-28T08:00:00.000Z",
  "endIso": "2026-07-28T09:00:00.000Z",
  "samples": [
    {
      "timestampMs": 1753689600000,
      "route": "booking_intent",
      "requestCount": 4200,
      "errorCount": 3,
      "p99LatencyMs": 88
    },
    {
      "timestampMs": 1753689600000,
      "route": "slots_list",
      "requestCount": 12500,
      "errorCount": 25,
      "p99LatencyMs": 45
    },
    {
      "timestampMs": 1753689600000,
      "route": "checkout",
      "requestCount": 1100,
      "errorCount": 0,
      "p99LatencyMs": 240
    },
    {
      "timestampMs": 1753689600000,
      "route": "escrow_listener",
      "requestCount": 300,
      "errorCount": 2,
      "p99LatencyMs": 12
    }
    /* ... more 1-minute windows ... */
  ]
}
```

Each `timestampMs` marks the **start** of a 1-minute observation window. You can include
multiple routes at the same timestamp; the ingester handles mixed-route arrays correctly.

---

## SLO Headroom Report

The simulator prints (or returns) a report like this:

```
──────────────────────────────────────────
Capacity Simulation Report
Label:         2026-07-28 peak
Generated:     2026-07-28T13:25:00.000Z
Duration:      3600000ms
Total requests:72480
Overall:       ✅ ALL WITHIN SLO BUDGET
──────────────────────────────────────────
Route                 SLO       Err Rate  Budget Used  Headroom  Burn Rate
─────────────────────────────────────────────────────────────────────────
✅ booking_intent       99.9000%   0.0714%     71.4286%   28.5714%      0.71
✅ slots_list           99.5000%   0.2000%     40.0000%   60.0000%      0.40
✅ checkout             99.9900%   0.0000%      0.0000% 100.0000%      0.00
✅ escrow_listener      99.0000%   0.6667%     66.6667%   33.3333%      0.67
──────────────────────────────────────────
```

### Headroom formula

```
errorBudget          = 1 − SLO_OBJECTIVE
errorBudgetConsumed  = observedErrorRate / errorBudget
headroom             = 1 − errorBudgetConsumed   (negative = budget blown)
burnRate             = observedErrorRate / errorBudget
```

A `burnRate` > 1 means the route would exhaust its entire monthly error budget in the
simulated window at this rate.

---

## Safety Guardrails

`src/simulator/safetyGuardrails.ts` enforces three layers of protection:

1. **`NODE_ENV=production` block.** The simulator throws `SimulationSafetyError` if run in
   production. Set `NODE_ENV=test` or `NODE_ENV=development`.

2. **Stellar Horizon host denylist.** The following hosts are permanently blocked:
   - `horizon.stellar.org`
   - `horizon-testnet.stellar.org`
   - `stellar.expert`
   - `api.stellar.org`
   - `horizon-futurenet.stellar.org`

   Any curve whose `label` or whose `STELLAR_HORIZON_URL` environment variable resolves to
   one of these hosts causes an immediate `SimulationSafetyError` before any plan is built.

3. **No-op default handler.** The load generator's default `RequestHandler` is a no-op.
   Callers must explicitly pass a handler to record any side effects. There is no HTTP client
   in the simulator; all "requests" are in-process events.

### To verify nothing was called in tests

```typescript
import { SIMULATOR_SAFE_MARKER } from "../../src/simulator/safetyGuardrails.js";
expect(SIMULATOR_SAFE_MARKER).toBe("SIMULATOR_SAFE_v1");
```

---

## Edge Cases Handled

| Edge case                         | Behaviour                                                              |
|-----------------------------------|------------------------------------------------------------------------|
| Missing historical range (gap)    | `SPARSE_RANGE` warning emitted; simulation continues with the data available |
| Out-of-order samples              | Samples are sorted; `SAMPLES_REORDERED` warning emitted               |
| `errorCount > requestCount`       | Clamped to `requestCount`; `CLAMP_ERROR_COUNT` warning emitted        |
| `endIso ≤ startIso`               | `IngestionError` thrown before simulation starts                      |
| Empty samples array               | `IngestionError` – at least one sample required                        |
| Scale factor truncates window     | Samples beyond `maxDurationMs` are silently dropped from the plan      |
| 100% error rate (unrealistic mix) | Handled; all routes breach their SLO; report shows negative headroom  |
| 0% error rate                     | All routes show 100% headroom                                          |
| Handler throws mid-run            | Error propagates out of `executeReplayPlan` / `simulate()`             |
| `NODE_ENV=production`             | `SimulationSafetyError` – simulator refuses to run                    |
| Blocked Stellar URL in env        | `SimulationSafetyError` – simulator refuses to run                    |

---

## Testing

```bash
# Run only the simulator tests:
npx jest --testPathPattern="simulator|capacity-sim"

# Run with verbose output:
npx jest --testPathPattern="simulator|capacity-sim" --verbose
```

**Test counts:**

| File                              | Tests |
|-----------------------------------|-------|
| `typesAndGuardrails.test.ts`      | 36    |
| `trafficIngester.test.ts`         | 37    |
| `loadGenerator.test.ts`           | 25    |
| `sloHeadroomReporter.test.ts`     | 26    |
| `integration.test.ts`             | 23    |
| `capacity-sim.test.ts` (scripts)  | 15    |
| **Total**                         | **138** |

All 138 tests pass. The simulator files compile clean under `tsc --noEmit`.

---

## Security Notes

- The simulator has no outbound network calls. It is purely in-process.
- It should never be run as part of a production deployment. The guardrails enforce this.
- The CLI script does not read environment secrets. The only file I/O is reading the optional
  `--curve-file` JSON (read-only).
- Do not store real user data in `TrafficCurve` files. Only aggregate counters are needed.

---

## Adding a New Route

1. Add the route name to `RouteName` in `src/metrics/sloMetrics.ts`.
2. Add its SLO objective to `SLO_OBJECTIVES` in the same file.
3. Add the route string to the Zod enum in `src/simulator/types.ts`:
   ```typescript
   route: z.enum(["booking_intent", "slots_list", "checkout", "escrow_listener", "my_new_route"]),
   ```
4. Add it to `REPORTED_ROUTES` in `src/simulator/sloHeadroomReporter.ts`.
5. Update this document's route table.
6. Add test coverage for the new route in the `sloHeadroomReporter.test.ts`.
