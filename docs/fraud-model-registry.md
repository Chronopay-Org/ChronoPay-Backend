# Fraud model registry

## Why

Fraud scoring evolves. Rule weights change, new signals are added, and bad
rules need to be rolled back. We need a registry that:

1. **Tracks multiple model versions** with content hashes (so we can verify
   which code was actually scoring a given request).
2. **Routes per-tenant** to a particular version with explicit overrides,
   so we can run a 1% canary against a single high-value tenant without
   touching the rest of the fleet.
3. **Promotes new versions atomically.** If the canary is good, the admin
   can shift traffic to 100% in one call.
4. **Emits an audit event** before mutating registry state, so every
   promotion is reconstructable.

## Data model

```ts
interface FraudModelConfig {
  version: string;          // "v2025-q1-r3"
  contentHash: string;      // sha256 hex of canonical config blob
  trafficWeight: number;    // integer 0..100 (registry metadata; the
                            // router takes its cue from promote-time weights)
  registeredAt: string;     // ISO timestamp
  registeredBy: string;     // admin actor id
}

interface RoutingSnapshot {
  snapshotId: string;                // monotonic, e.g. "snap-3"
  cumulative: Array<{ upper: number; version: string }>;
  overrides: Map<string, string>;    // tenantId -> version
  defaultVersion: string;            // highest-weight (parked versions excluded)
  versions: Set<string>;             // versions actively receiving traffic
}
```

## Promotion endpoint

```
POST /api/v1/admin/fraud-models/promote
Headers: x-chronopay-admin-token: <token>
Body:
{
  "weights": { "<version>": <integer 0..100> },
  "tenantOverrides": { "<tenantId>": "<version>" }
}
```

Validation rules (all enforced before any state mutation):

- Weights object must be present and a string-keyed map.
- Every weight is a non-negative integer in `[0, 100]`.
- Σ weights = 100 exactly.
- Every key in `weights` and `tenantOverrides` must reference a registered
  version; otherwise the response is `400` with `code` = `UNKNOWN_VERSION`
  or `INVALID_OVERRIDE`.

Response on success:

```json
{
  "success": true,
  "snapshot": {
    "snapshotId": "snap-1",
    "cumulative": [{ "upper": 70, "version": "v1" }, ...],
    "overrides": { "tenantA": "v2" },
    "defaultVersion": "v1",
    "versions": ["v1", "v2"]
  },
  "removedVersions": [],
  "removedOverrides": []
}
```

Field meanings:

- `removedVersions`: model versions that were registered in the previous
  snapshot but were assigned weight 0 in the new plan (i.e. they leave
  the routing table but stay in the registry).
- `removedOverrides`: tenant bindings that were active in the *previous*
  snapshot but will not be active in the new one — because the tenant is
  no longer mentioned in the promotion, was retargeted to a different
  version, or its target version lost its traffic weight. Override
  entries in the new request that target a weight-0 version are NOT
  included here; they never activated and are reported via `warnings`
  (`OVERRIDE_TARGET_WEIGHT_ZERO`).

A read-only companion endpoint:

```
GET /api/v1/admin/fraud-models/list
Headers: x-chronopay-admin-token: <token>
→ 200 { "success": true, "models": [ ... ] }
```

## Routing algorithm

Per request:

1. Resolve the in-flight `RoutingSnapshot` (captured at request entry —
   see "Snapshot safety" below).
2. If `tenantId` has an override in the snapshot, route to that version.
3. Otherwise, project the tenant id into `[0, 99]` via SHA-256 (first 4
   bytes, big-endian uint32) mod 100, then walk the `cumulative` table
   to find the version whose `upper` covers that bucket.

This gives the following:

- Two consecutive requests from the same tenant always land on the same
  version, even across process restarts, so live scoring is stable.
- A change in weights bumps `snapshotId` and only affects requests
  captured against the new snapshot.
- Per-tenant overrides (a small map) take precedence over the bucket,
  allowing a 1% canary to be a single tenant plus a few buckets.

The snapshot's `versions` Set tracks ONLY versions with positive weight
— "parked" (weight 0) entries stay in the registry but not the routing
table, so they can't accidentally serve traffic even though they're
recognised models.

## Snapshot safety (mid-request promotion)

When a request handler captures `const snap = registry.getLatestSnapshot();`
and passes that snapshot through the rest of the handler, subsequent calls
to `promote(...)` create a brand-new `RoutingSnapshot` and route later
requests to the new one. The in-flight handler keeps using its captured
snapshot, so partial state is impossible.

Tests in `src/services/__tests__/fraudModelRegistry.test.ts` cover this
scenario directly: a `getLatestSnapshot()` taken before `promote(...)` is
faithful even after a subsequent mutation.

## Audit envelope

Every successful promote emits **two** entries:

1. `FRAUD_MODEL_PROMOTED` with `status: "attempted"`, recording the
   weights + overrides the admin submitted.
2. `FRAUD_MODEL_PROMOTED` with `status: 200`, recording the new snapshot
   id and removed versions.

A rejected request emits a single `FRAUD_MODEL_PROMOTE_REJECTED` entry
with the validation `code`s as the reason.

All entries go through `defaultAuditLogger` and share the existing
`AuditEventV1` envelope. Reuse the
[`docs/SECURITY_VALIDATION.md`](./SECURITY_VALIDATION.md) redaction rules;
no PII lives in this surface because the only inputs the operator is
allowed to send are version ids (`v…`) and arbitrary tenant ids (already
known to the system).

## Runbook

### I just ran a promotion — what happens to in-flight requests?

Nothing. They keep using the snapshot captured at request entry.
Subsequent requests use the new snapshot. The audit log captures both
events for forensic review.

### I want to roll back a bad promotion

Call `POST /api/v1/admin/fraud-models/promote` again with the previous
weights and overrides. Because promote is idempotent on weights (the
snapshot id is a monotonic counter, not a content hash), re-promoting the
same weights just bumps `snapshotId` and writes a new audit entry.

### A tenant complains their fraud score is "stuck" on a canary version

Check `GET /api/v1/admin/fraud-models/list` first to confirm the version
is still active, then re-promote without the tenant override or with the
override pointing at the new champion version.

## Security notes

- The promotion endpoint is gated by `requireAdminToken`, which checks the
  `x-chronopay-admin-token` header against `process.env.CHRONOPAY_ADMIN_TOKEN`.
  Misconfigured deployments (no token configured) refuse every request.
- Audit-first: the emit happens **before** the registry mutation. If the
  audit write fails (disk full, permission denied), the route still
  proceeds — the logger falls back to a console error so the failure is
  observable without breaking the request flow.
- Per-tenant overrides are not PII; they are the platform's internal
  tenant identifiers, already vetted by the authn layer.
- All numeric inputs (weights) are validated as non-negative integers in
  `[0, 100]` and Σ ≤ 100; arbitrary floats cannot be smuggled in.
- The `cumulative` table is bounded by the number of registered versions
  (currently small and capped at 16 in tests). A pathological registry
  with thousands of versions would still produce a linear traversal,
  never nested — the O(1) bucket lookup is preserved.

## Tests

| File                                              | Coverage                                        |
|---------------------------------------------------|-------------------------------------------------|
| `__tests__/fraudModelRegistry.test.ts`            | Validate weights, register, promote, snapshots  |
| `__tests__/fraudTrafficRouter.test.ts`            | Hash distribution, bucketing, overrides        |
| `routes/__tests__/fraudModels.test.ts`            | Admin route: 401/403/400/200, audit envelope    |
