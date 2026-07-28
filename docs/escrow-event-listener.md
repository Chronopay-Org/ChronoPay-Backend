# Escrow Event Listener — Public Contract

## Overview

The escrow listener polls the escrow contract for `Held`, `Released`,
`Refunded`, and `Slashed` events and projects them onto the local booking
model. It runs as a single-instance per-process worker; multiple instances
share the same Redis-backed idempotency + cursor store so concurrent polls
converge to the same final state without duplicates.

This document is normative: every guarantee listed here MUST hold, and any
change that relaxes a guarantee requires a corresponding update.

---

## Guarantee 1 — Idempotent Event Processing

For any escrow event with identity `(txHash, eventIndex)`, the listener
applies its side-effects **at most once** across the lifetime of the
process, regardless of crashes, replays, or overlapping ticks.

**Mechanism**
- Each event passes through `IdempotencyStore.claim(eventKey)`, which
  atomically issues `SET escrow:listener:idempotency:{txHash}:{eventIndex} 1
  EX 7d NX` against Redis.
- A successful claim means the listener owns the projection and may apply
  state changes. A failed claim means another worker (or a previous tick)
  already handled this event and we must skip.

**Crash interaction**
- If the listener crashes AFTER claiming but BEFORE advancing the cursor,
  on restart the same event is re-fetched. The idempotency claim is
  released (via `safeRelease`) only when the projector itself throws. For
  successful projections, the claim persists for 7 days so re-runs are
  safe no-ops. After 7 days, the event has long since been finalized on
  chain; re-claim on a long-delayed restart is still safe because the
  cursor mechanism bounds the re-fetch window.

---

## Guarantee 2 — Cursor Monotonicity

The cursor, stored under `escrow:listener:cursor:{instanceId}`, is a single
non-negative integer representing the highest ledger sequence whose events
have been **durably projected** to booking + slot state.

**Monotonicity**
- `CursorStore.set` rejects any value strictly less than the current
  value. Callers must never regress the cursor.
- The cursor advances exactly once per tick, AFTER every event in the
  fetched page has been (re-)projected.
- If the cursor write fails, the tick throws and the cursor remains at
  its previous value. Future ticks re-fetch the same window; the
  idempotency store short-circuits replays so the work is cheap and safe.

**Redaction, ordering, replayability**
- The cursor's persisted value can be inspected at any time for monitoring.
- Ticks are independently runnable; the loop wrapper `runEscrowListener`
  is purely for cadence control.

---

## Guarantee 3 — Finality Window

Events newer than `tip - finalityDepth` ledgers are not applied yet. The
listener always operates on the **safe tip**:

```
safeTipSeq = max(0, latestLedgerSeq - finalityDepth)
```

Default `finalityDepth` is 2 (configurable via `EscrowListenerOptions`).
This width absorbs the modest reorg probability for production chains
while keeping freshness latency bounded.

**Why this matters**
- Reorgs within `finalityDepth` cause the same event to be re-emitted with
  a different `txHash` (or different content). The idempotency gate
  short-circuits the re-emit only when the `(txHash, eventIndex)` tuple
  matches; reorgs with different `txHash` values are taken at face value
  and projected via the state machine.
- The state machine (`Released` after `Held` is a no-op, etc.) absorbs
  the rare case where a reorg delivers the same logical event twice with
  different tx identities.

---

## Guarantee 4 — Strict State-Machine Conformance

Every projected event follows these rules on the local
`BookingIntentRecord`:

```
  pending ──Held──▶ confirmed ──┐
     │                            ├──Released──▶ cancelled (slot freed)
     ├──────────Released──────────┘
     ├──────────Refunded──────────▶ cancelled (slot freed)
     ├──────────Slashed───────────▶ expired    (slot freed, alert metric)

  confirmed ──Refunded──▶ cancelled (slot freed)
  confirmed ──Slashed────▶ expired   (slot freed, alert metric)

  confirmed ──Released──▶ cancelled (slot freed)  [service complete payout]
```

Terminal states (`cancelled`, `expired`) are absorbing. The state-machine
publishes one of seven outcomes per event:

| Outcome                  | Meaning                                               |
|--------------------------|-------------------------------------------------------|
| `applied`                | State transition applied successfully.               |
| `noop_slot_already`      | Intent was already in the target state (replay).      |
| `noop_terminal_intent`   | Intent was in a terminal state; no transition allowed.|
| `noop_unknown_intent`    | No active intent for the slot; nothing to update.     |
| `noop_illegal_transition`| Combination of `kind` × status was not in the table.  |
| `noop_slot_missing`      | Slot was not in the local repository.                 |
| `noop_rejected_address`  | Contract address not in the listener's allow-list.    |

Every outcome is counted in the prom counter
`escrow_listener_events_processed_total{event_kind, outcome}`.

---

## Guarantee 5 — Allowlist-Only Sources

Each listener instance has a `contractAddressAllowList`. Empty allow-list
is treated as an error condition: every event is rejected as
`noop_rejected_address`. This is a secure-by-default posture so misconfigured
deployments cannot accidentally accept events from arbitrary contracts.

The allow-list is enforced at TWO layers:
1. The contract client passes `contractAddresses` to `getEvents({...})` so
   most non-allow-list events never travel the wire.
2. The projector independently re-checks the address, in case a future
   client implementation is more permissive.

---

## Guarantee 6 — Crash Recovery Without Manual Intervention

If the listener crashes or is restarted, the system recovers without
operator action and without losing events. The recovery sequence is:

1. On startup the cursor is read from `escrow:listener:cursor:{id}`.
2. The tick fetches `getEvents({ startLedger: cursor + 1 })`.
3. Every event in the page is gated by the idempotency store. Events
   already seen → counted as `noop_slot_already` and skipped.
4. New events are projected via the state machine.
5. Cursor advances only after every event has been processed.

**Crash window correctness**
- Crash BEFORE any claim → no state changed, replayed cleanly on next tick.
- Crash AFTER some claims but BEFORE cursor advance → those events become
  duplicate on re-fetch (idempotency gate), unclaimed events are projected
  cleanly, cursor still advances monotonically.
- Crash BETWEEN claim and projection → `safeRelease` runs in the
  `catch` path so the claim is cleared; next tick re-applies cleanly.

---

## Guarantee 7 — Freshness SLO

The listener observes the following SLO:

> Across any 6-hour window, ≥ 99 % of ticks in which events were applied
> must observe a freshness within 60 seconds.

**Definitions**
- `freshness_seconds = max(0, now - latest_applied_event_closeTime)` per
  tick.
- `freshness_exceeded_slo = freshness_seconds > 60` per tick.
- Per-tick verdicts are recorded into the existing SLO machinery via
  `recordRouteTraffic("escrow_listener", freshOrStale)` and feed the
  burn-rate gauge `slo_burn_rate{route="escrow_listener", window=...}`
  in the same way as `booking_intent` and `checkout`.

**Why "applied events only"?**
A tick with no events didn't lose any work, so its freshness should not
drain the error budget. Burn rate is computed from the population where
the listener actually made progress.

---

## Metrics Surface

| Metric                                                    | Type      | Labels                  | Purpose                                    |
|-----------------------------------------------------------|-----------|-------------------------|--------------------------------------------|
| `escrow_listener_events_processed_total`                 | counter   | event_kind, outcome     | Per-event projection breakdown             |
| `escrow_listener_lag_sequences`                           | gauge     | instance_id             | safeTip − cursor; alert if unbounded       |
| `escrow_listener_freshness_seconds`                      | histogram | instance_id             | Wall-clock age feed for SLO calculation    |
| `escrow_listener_slashed_events_total`                    | counter   | —                       | Alert-worthy penalty events                |
| `escrow_listener_cursor_advances_total`                  | counter   | —                       | Sanity check on loop progress              |
| `escrow_listener_duplicate_idempotency_hits_total`       | counter   | —                       | Replays seen                               |
| `escrow_listener_tick_errors_total`                      | counter   | error_type              | Transport + cursor + projection errors     |

Cardinality budgets (per `src/metrics.ts`) are enforced at registration.

---

## Operator Runbook

**Restart stuck listener**
- Inspect `escrow_listener_lag_sequences{instance_id=...}`. A persistently
  growing lag indicates a stuck tick. Verify the network tip with the
  contract client in isolation.
- If the cursor is wedged, wipe the cursor key with
  `DEL escrow:listener:cursor:{instanceId}` and the listener will re-walk
  from genesis (only with the idempotency store present will this be safe).

**Replay a specific ledger region**
- Start a new listener instance with `instanceId="recovery-{ts}"` and a
  cursor seeded to `ledgerSeq - 1`. The listener will re-fetch and apply
  events in the safe window; the idempotency gate prevents re-applying
  events already projected by the primary instance.

**Investigate SLO breach**
- Pull `slo_burn_rate{route="escrow_listener"}` over the 1h and 6h windows.
- Correlate with `escrow_listener_tick_errors_total` (transport failures
  usually precede a freshness breach).
- If the breach is recurrent, raise `finalityDepth` to give the listener
  more breathing room — at the cost of slightly older projected events.
