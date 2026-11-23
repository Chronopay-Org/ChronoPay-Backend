# Senior-panel dispute appeal workflow

## Why

A single arbiter's ruling is not the final word. Either party may appeal a
dispute outcome to a senior panel of *unrelated* arbiters within a fixed
window after adjudication. The senior panel is the final authority — its
decision is sealed into a tamper-evident hash chain that any investigator
can replay from genesis.

This document covers:

1. The state machine and its allowed transitions.
2. The panel composition rules (Conflict-of-Interest exclusions).
3. The appeal window enforcement.
4. The hash chain format and recomputation recipe.
5. The audit envelope as emitted by the route handler.
6. Operational runbook.

## State machine

```
                                  ╔══════════════════╗
                                  ║ Dispute timeline ║
                                  ╚══════════════════╝

  OPEN ──► EVIDENCED ──► ADJUDICATED ──► APPEALED ──► SENIOR_REVIEW ──► FINAL
   │           │              │              │             │
   │           │              │              │             │
   ▼           ▼              ▼              ▼             ▼
  TIMEOUT    TIMEOUT       CLOSED          CLOSED        (terminal)
                                                 (= chain stops here)
```

`src/services/disputeAppeals.ts` exposes `canTransition(current, target)`,
the single source of truth for which transitions are accepted. Terminal
states (`FINAL`, `CLOSED`, `TIMEOUT`) have an empty transition list and
cannot be re-opened — that is what blocks "appeal of appeal".

## Appeal window

A dispute becomes appealable immediately after the `ADJUDICATED` chain
link is appended and remains appealable for `appealWindowMs` (default
72 h) past its `adjudicatedAt` timestamp. The route handler resolves
the window via `isWithinAppealWindow(dispute, now)`:

- **Missing `adjudicatedAt`** → not appealable (treat as outside window).
- **Now - adjudicatedAt ≤ window** → acceptable.
- **Now - adjudicatedAt > window** → 410 `APPEAL_WINDOW_EXPIRED`.

Tests at `src/services/__tests__/disputeAppeals.test.ts`
("isWithinAppealWindow") exercise both the default and a per-dispute
override window.

## Senior-panel composition

Every appeal selects ≥ `SENIOR_PANEL_MIN_SIZE` (3) senior arbiters from
the in-process pool defined by `getSeniorPool()` / `addSeniorArbiter()`
in `src/services/disputeAppeals.ts`. Three exclusion classes run first:

| Reason code         | Why the senior is excluded                                                |
|---------------------|---------------------------------------------------------------------------|
| `ORIGINAL_ARBITER`  | The arbiter who adjudicated the original ruling cannot review their own decision. |
| `PARTY_CONFLICT`    | The senior's `tenantId` matches `dispute.buyerTenantId` *or* `dispute.supplierTenantId`. |
| `APPEAL_OF_APPEAL`  | The senior already served on a prior panel for this dispute (defends against a second appeal). |

After exclusion the remaining candidates are sorted alphabetically by
`id` and the first three are taken. Sorting is deterministic so two
identical selection runs (same pool + same dispute) always produce the
same composition — this matters for audit replay.

If the candidate pool has fewer than three survivors, the request is
rejected with **503 `INSUFFICIENT_SENIOR_POOL`** and the dispute stays
in `ADJUDICATED` (no state mutation on rejection).

## Hash chain

Every status transition appends one link to the dispute's
`finalityChain`. The link formula is:

```
hash = sha256(prevHash || "|" || disputeId || "|" || status || "|" ||
              canonicalJson(payload) || "|" || ts)
```

- `prevHash` is the SHA-256 of the previous link, or 64 zero hex chars
  ("genesis") if the chain has no prior links.
- `payload` is canonicalised by `stableStringify` (see
  `src/utils/hash.ts`) — identical logical payloads always produce
  identical hashes.
- `ts` is the Unix epoch ms at which the link was bound. Including it
  means an identical logical transition at two different times produces
  two distinct hashes.

Worked example for a 3-link chain:

```
link 1: EVIDENCED   prev="0…0"           payload={evidenceCount:1}  ts=1700…
link 2: ADJUDICATED prev=sha256(link1)   payload={ruling:"BUYER_FAVOR",arbiter:"a"}
link 3: APPEALED    prev=sha256(link2)   payload={actor:"admin-1",panel:["sa-1","sa-2","sa-3"]} ts=1700…
```

Tampering with any earlier link breaks every later link's
recomputation; the `latest.finalityHash` won't match a fresh rebuild.
This serves as the tamper-evident seal: investigators don't need to
trust the storage layer, only the Genesis placeholder.

## Audit envelope

The route handler emits `defaultAuditLogger.log(...)` calls with a
versioned `AuditEventV1` envelope (`AUDIT_SCHEMA_VERSION = "1.0.0"`).
Actions emitted:

| Action                          | When                                                   |
|---------------------------------|--------------------------------------------------------|
| `DISPUTE_APPEAL_INITIATED`      | Audit-first, before state mutation. `status: "attempted"`. |
| `DISPUTE_APPEAL_REJECTED`       | Reasons: `ALREADY_FINAL` (treated as INVALID_STATE), `APPEAL_OF_APPEAL`, `WINDOW_EXPIRED`, `INSUFFICIENT_SENIOR_POOL`, `INVALID_STATE`. `status: "rejected"`. |
| `DISPUTE_SENIOR_PANEL_SELECTED` | After panel is selected and dispute is in SENIOR_REVIEW. `status: 200`. |
| `DISPUTE_FINAL`                 | When SENIOR_REVIEW → FINAL with the senior decision.   |
| `DISPUTE_FINAL_REJECTED`        | Bad vote set (PANEL_VOTE_MISMATCH, INSUFFICIENT_VOTES, INVALID_STATE). |

Audit write failure must never block a dispute state transition; `logAudit`
catches and discards errors. The fallout is observable through the
logger's own console-error fallback (already wired in the existing
`AuditLogger.log` implementation).

## Security notes

- The appeal and senior-decide endpoints are gated by the existing
  `requireAdminToken` middleware; in production a finer-grained RBAC
  belongs in front (e.g. dispute support role). The mock surface here
  uses the admin token as a placeholder.
- The senior arbiter pool is in-process. A real deployment should
  mirror `addSeniorArbiter` to a backing store that the dispute layer
  reads from (see the followups for a DB-backed registry).
- `canTransition` is consulted on EVERY state change. There is no path
  that bypasses it; even the timeout route consults it.
- The hash chain does not provide confidentiality — payloads are
  plaintext. Sensitive fields should be redacted before being passed
  into `appendFinalityLink`. The redact util lives in
  `src/utils/redact.ts` (see existing audit-log redaction rules).
- A successful OVERRUND reverses the ledger movement caused by the
  adverse original ruling. The audit trail captures both the original
  ruling link and the FINAL overturn link, so an investigator can
  reconcile the buyer's and supplier's balances from the chain alone.
- "Appeal-of-appeal" is enforced by THREE checks at three layers:
  state-machine (`APPEALED` not allowed to skip to `FINAL`), audit
  reason code (`APPEAL_OF_APPEAL`), and panel exclusion. All three
  must hold for a second appeal to be silently accepted.

## Runbook

### "An appeal was rejected as INSUFFICIENT_SENIOR_POOL"

1. Check `addSeniorArbiter(<id>, <tenantId>)` calls for the senior pool
   to confirm at least three arbiters outside both parties' tenants
   exist.
2. If the pool is thin, register more senior arbiters before any
   further appeals can be processed. This is the right move even if
   the operator wants to manually drive one — the dispute has been
   refused a panel.
3. Once the pool is replenished, the operator can re-issue the appeal
   by replaying the original `POST /:id/appeal` request. The dispute
   is still in `ADJUDICATED` (no transition happened), so this is a
   safe replay.

### "An appeal was accepted but the panel selection looked wrong"

1. Pull the dispute via `GET /:id/finality` and inspect the
   `SENIOR_REVIEW` payload. It contains the panel ids.
2. Run `selectSeniorPanel(getSeniorPool(), dispute)` locally using the
   same pool snapshot and confirm the composition.
3. If the panel has a hidden conflict, that's a bug in
   `selectSeniorPanel` — please file with the audit envelope as
   evidence.

### "The senior-decide endpoint returned PANEL_VOTE_MISMATCH"

1. Verify the votes came from arbiters on the assigned panel — the
   `SENIOR_REVIEW` chain link payload contains the panel ids.
2. If a non-panel arbiter voted, the operator must reissue the
   decision with the correct panel; the dispute does NOT change state
   in the meantime.
3. There is no automatic retry. Avoid automation that retries the
   vote without checking panel membership — that creates stale chain
   links.

## Touch list

- `src/types/dispute.ts`  — Domain types (Dispute, FinalityRecord, etc.).
- `src/services/disputeAppeals.ts` — Pure logic (state machine, panel
  selection, hash chain, in-process pool).
- `src/routes/admin.ts` — Route handlers, audit logger integration.
- `src/services/__tests__/disputeAppeals.test.ts` — Pure unit tests.
- `src/routes/__tests__/admin.disputes.appeals.test.ts` — HTTP-level
  integration tests.
- `src/routes/__tests__/admin.disputes.test.ts` — Legacy smoke tests,
  updated for the new strict state machine + senior-pool surface.
