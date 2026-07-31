# Test notes — per-tenant leaky-bucket for /bookings/search

Captured on branch `feat/tenant-leaky-bucket-search`.
Command per `package.json`: `npm test` (jest, `--runInBand`).

## New suites (this change)

```
PASS src/middleware/__tests__/tenantLeakyBucket.redis.test.ts
PASS src/middleware/__tests__/tenantLeakyBucket.test.ts
PASS src/routes/__tests__/bookings.test.ts
Test Suites: 3 passed, 3 total
Tests:       62 passed, 62 total
```

Coverage (scoped to the two new modules, `--collectCoverageFrom`):

| File | Stmts | Branch | Funcs | Lines |
| --- | --- | --- | --- | --- |
| src/middleware/tenantLeakyBucket.ts | 100% | 97.14% | 100% | 100% |
| src/routes/bookings.ts | 100% | 98.27% | 100% | 100% |
| **All files** | **100%** | **97.65%** | **100%** | **100%** |

Residual uncovered branches are defensive by design: the production
`require("ioredis")` fallback (unreachable under test injection) and a
null-guard for `auth.userId` that the auth middleware makes unreachable over
HTTP. Both exceed the 95% requirement.

## Edge cases from the issue — where each is covered

| Required edge case | Test |
| --- | --- |
| Burst then sustained | `tenantLeakyBucket.test.ts` → “burst then sustained: 120-request burst passes, 121st is throttled, bucket refills at 60 rps” (also E2E in `bookings.test.ts`) |
| Tenant switch mid-connection | `tenantLeakyBucket.test.ts` → “tenant switch mid-connection charges the correct bucket each request” |
| Redis latency spike | `tenantLeakyBucket.test.ts` → “enforces the timeout on a latency spike instead of hanging” + “a slow store fails open within the timeout and the response completes” |
| Noisy tenant can't starve others | `tenantLeakyBucket.test.ts` → “noisy tenant cannot starve other tenants”; `bookings.test.ts` → E2E |
| Atomicity (Lua on Redis) | `tenantLeakyBucket.redis.test.ts` → Lua ↔ JS parity on a real Lua VM (ioredis-mock): burst, throttle, drain, clock skew, EVALSHA caching, NOSCRIPT fallback |
| 429 + Retry-After | middleware + route tests assert header and body contract |
| Metric | `rate_limit_bucket_burn{tenant}` set on every request; `rate_limit_redis_failures_total` on fail-open |

## Full-suite regression check (`npm test`)

The repository's `main` is already heavily broken upstream (654 failing tests
across 175 suites: bad upstream commits with syntax errors in
`marketplaceSearchSchema.ts` / `marketplaceSearchService.ts`, missing exports
like `FraudReasonCode`, undefined helpers like `resetSeniorPool`, etc.). To
compare like-for-like, all 257 suites were executed in chunks on both
`origin/main` and this branch in an otherwise memory-constrained sandbox (a
single monolithic `--runInBand` process OOMs after ~175 suites even on main).

Result:

- Failing suites on `main`: 175
- Failing suites on this branch: 171 (all also failing on `main`)
- Suites failing **only** on this branch (regressions): **0**
- Two suites (`reranker`, `db-instrumentation`) failed on `main`'s chunk run
  but pass when re-run individually on `main` → flaky pre-existing tests,
  unrelated to this change.

`tsc --noEmit`: 7 errors before and after the change — all pre-existing
syntax errors on `main`; this change adds zero compile errors. ESLint: clean
for every new/modified file (2 pre-existing unused-function errors in
`src/config/env.ts` remain on `main`, untouched).
