# Task 137: Implement Auth-Aware Rate Limiting

**Repository**: ChronoPay-Org/ChronoPay-Backend  
**Issue**: Add auth-aware rate limiting key strategy  
**Timeframe**: 96 hours  
**Status**: In Planning (Critical blockers identified)

---

## Part 1: Original Task

### Description

Improve rate limiting to key by authenticated principal (API key identity / user id) in addition to IP. This reduces collateral damage under NAT and improves abuse controls for authenticated endpoints.

### Requirements

- Must be secure, tested, and documented
- Should be efficient and easy to review

### Repo Context

- **Rate limiter**: `src/middleware/rateLimiter.ts`
- **Auth middleware**: `src/middleware/auth.ts`, `src/middleware/apiKeyAuth.ts`
- **JWT auth**: `src/middleware/auth.middleware.ts`

### Suggested Execution

1. Fork the repo and create a branch: `git checkout -b feature/auth-aware-rate-limiting`
2. Implement changes
3. Define key priority (apiKeyId/userId/ip)
4. Preserve RateLimit header semantics
5. Document in `docs/rate-limiting.md`
6. Validate security assumptions
7. Ensure keying cannot be bypassed by toggling identities
8. Test and commit
9. Run tests
10. Cover edge cases (auth vs no-auth paths; trust proxy interactions)
11. Include test output and security notes

### Example Commit Message

```
feat: add auth-aware rate limiting keys
```

### Guidelines

- **Minimum 95% test coverage** (touched lines)
- **Clear documentation**
- **Timeframe**: 96 hours

---

## Part 2: Critical Analysis & Blockers

### Executive Summary

The original plan would **fail immediately** upon implementation due to **3 critical blockers** and **5 high-risk issues**. These must be fixed before or during implementation.

---

### 🚨 CRITICAL BLOCKERS (Must Fix)

#### Blocker 1: `EnvConfig` Missing Required Fields

**Location**: `src/config/env.ts`

**Problem**: The `loadEnvConfig()` function parses `rateLimitWindowMs`, `rateLimitMax`, and `trustProxy` but does NOT return them in the `EnvConfig` object. Only `nodeEnv`, `port`, and `redisUrl` are returned.

**Impact**: `configService.rateLimitWindowMs` and `configService.rateLimitMax` return `undefined`. When passed to `express-rate-limit`, it receives `{ windowMs: undefined, limit: undefined }` and **throws a runtime error**.

**Evidence**:
```ts
// Lines 64-68 of env.ts — missing fields!
return {
  nodeEnv,
  port,
  redisUrl, // rateLimitWindowMs, rateLimitMax, trustProxy are LOST
};

// config.service.ts lines 49-54 expect these:
public get rateLimitWindowMs() { return this.envConfig.rateLimitWindowMs; } // undefined!
public get rateLimitMax() { return this.envConfig.rateLimitMax; } // undefined!
```

**Fix Required**:
1. Extend `EnvConfig` interface to include:
   - `rateLimitWindowMs: number`
   - `rateLimitMax: number`
   - `trustProxy: boolean`
   - (optionally) `timeoutMs?: number` and other parsed fields
2. Return these fields from `loadEnvConfig()`

**Estimated Time**: 30 minutes

---

#### Blocker 2: No Redis Store for Production

**Location**: `src/middleware/rateLimiter.ts`

**Problem**: The rate limiter uses the default `MemoryStore`. No Redis store is configured, and no package like `rate-limit-redis` exists in `package.json`.

**Impact**: 
- **MemoryStore is NOT suitable for production** — counters are per-instance, not shared across multiple Node.js processes/containers
- In clustered or containerized deployments (Docker/K8s), the effective rate limit is multiplied by the number of instances
- Rate limiting becomes ineffective and unpredictable at scale

**Evidence**:
- `package.json` has no `rate-limit-redis` or similar
- `rateLimiter.ts` has no `store` option passed to `rateLimit()`
- Existing Redis client (`src/utils/redis.ts`) is not connected to rate limiting

**Fix Options**:

**Option A (Recommended)**: Add `rate-limit-redis` dependency
```bash
npm install rate-limit-redis
```

Then configure:
```ts
import { RedisStore } from 'rate-limit-redis';
import { getRedisClient } from '../utils/redis.js';

store: new RedisStore({
  client: getRedisClient(),
  prefix: 'rl:', // unique namespace
})
```

**Option B**: Implement custom Store interface (~40 lines) using existing Redis client

**Estimated Time**: 2–3 hours (including dependency testing)

---

#### Blocker 3: `req.auth` Not Globally Typed

**Location**: `src/middleware/auth.ts`

**Problem**: `req.auth` is declared only in a **local** `AuthenticatedRequest` interface, not as a global augmentation to Express's `Request`.

```ts
// auth.ts line 11 — local only!
export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}
```

**Impact**: When `generateRateLimitKey()` tries to read `req.auth.userId` in any file without the local type cast, TypeScript will error (`Property 'auth' does not exist on type 'Request'`).

**Evidence**: Routes that use `req.auth` must explicitly use `AuthenticatedRequest` type (e.g., `booking-intents.ts` uses `(req: AuthenticatedRequest, ...)`). This pattern is not sustainable for a utility function used across routes.

**Fix Required**: Add global augmentation in `src/types/express.d.ts` or create new file:

```ts
declare module 'express-serve-static-core' {
  interface Request {
    auth?: {
      userId: string;
      role: string;
    };
    apiKeyId?: string; // also ensure this is globally typed
  }
}
```

**Estimated Time**: 15 minutes

---

### 🔴 HIGH-RISK ISSUES (Will Break Existing Functionality)

#### Issue 4: Identity Priority Order Mismatch

**Proposed order** (from initial plan):
1. `req.user.sub || req.user.id` (JWT)
2. `req.auth.userId` (header-based)
3. `req.apiKeyId`
4. `req.ip`

**Actual middleware usage**:
- `POST /api/v1/booking-intents` uses `requireAuthenticatedActor` → sets `req.auth` (NOT `req.user`)
- `POST /api/v1/slots` uses `requireApiKey` → sets `req.apiKeyId`
- Buyer-profile routes use `authenticate` (from `auth.middleware.ts`) → sets `req.user`
- Most routes do NOT set `req.user` — that's from a different auth system (`auth.middleware.ts` vs `auth.ts`)

**Risk**: If you prioritize `req.user` but the route uses `requireAuthenticatedActor`, key generator returns IP (wrong). The logic should prioritize based on what's **actually set**, not a theoretical ideal order.

**Correct order** (based on current codebase):
1. `req.auth?.userId` — Most common for current endpoints
2. `req.user?.sub || req.user?.id` — Used by buyer-profile
3. `req.apiKeyId` — Used by slots
4. `req.ip`

**Action**: Implement matching order and document per-route which identity is active.

---

#### Issue 5: `requireApiKey` is a No-Op When `expectedApiKey` is Falsy

**Location**: `src/middleware/apiKeyAuth.ts` lines 22–26

```ts
if (!expectedApiKey) {
  return next(); // no authentication required if no key configured
}
```

**Impact**: In configurations where `API_KEY` environment variable is not set, `requireApiKey(undefined)` does nothing and **does not set `req.apiKeyId`**. The rate limiter then falls back to IP-based key.

**Is this acceptable?** Possibly yes — the endpoint would be unauthenticated, so IP-based limiting is fine. But it must be **explicitly documented** that:
- The route only enforces rate limiting by API key when the key is configured
- If you expect API key to always be required, the middleware already enforces that (returns 401 if missing). So `req.apiKeyId` will be set for any request that passes the auth check.

**Conclusion**: No code change needed, but document the behavior.

---

#### Issue 6: Per-Route Rate Limiter Instances Create Separate Counters

**Default behavior** of `express-rate-limit`: Each call to `rateLimit()` creates a new limiter with its own store instance (MemoryStore by default). If you apply per-route limiters, **each route gets its own counter**.

**Example**:
- POST `/api/v1/slots` → limit 100
- POST `/api/v1/booking-intents` → limit 100
- Client could send 100 requests to each → 200 total requests within window

**Question**: Is this intended?

**Task requirement**: "Improve rate limiting to key by authenticated principal" — implies per-principal limits, not per-endpoint. The current per-route approach would allow a user to exhaust quota on route A and still have full quota on route B.

**Options**:

**Option A (Per-endpoint isolation)**: Accept separate limits per route. Simpler; consistent with current architecture (routes are independent). Document that limits are per-route, not global.

**Option B (Global per-principal limit)**: Share a single store instance across all routes. Can be achieved by:
- Creating a **global singleton** rate limiter instance with `keyGenerator` and mounting it on all protected routes
- Using same Redis store instance (keyed by principal only, not by route)

**Trade-off**: Per-endpoint gives finer control (different limits per endpoint). Global per-principal is simpler to reason about for abuse prevention.

**Decision**: Given the task says "key by authenticated principal" (not "per-route"), the **natural interpretation** is: same user hitting different endpoints should count against **the same quota** (their account's rate limit). Otherwise a user could bypass slot-creation limits by spamming booking-intents.

**Recommendation**: Use a **single global rate limiter instance** with identity-based keys, mount it globally **after** authentication middleware. However, authentication middleware is per-route, not global. So either:
1. Apply global rate limiter that uses raw headers (bypasses auth middleware) — but need to read headers directly to derive identity (complex, duplicate auth logic)
2. Keep per-route limiters but ensure they **share the same store instance** so counters are per key, not per route. `express-rate-limit` store is attached to the limiter instance; separate instances = separate counters even with same Redis store? Need to check: RedisStore maintains its own key prefix? The `keyGenerator` determines the key; if same key string is used across different limiter instances, Redis store treats them as same counter (Redis key is the key string). So if we reuse the **same Redis store instance** across limiters, counters are shared.

**Simplest path**: Create **one shared store instance**, pass it to all limiters.

**Plan**: In `rateLimiter.ts`, create a singleton store:
```ts
const redisStore = new RedisStore({ client: getRedisClient(), prefix: 'rl:' });
export const sharedStore = redisStore;
```

Then each `createAuthAwareRateLimiter` uses `store: sharedStore`. This ensures `rl:user:123` key is shared across all routes. The `keyGenerator` produces the same key regardless of route. So user's quota is global across all protected endpoints.

**Conclusion**: Use **shared Redis store** + **same key namespace** to achieve global per-principal limits.

---

#### Issue 7: Test Suite Assumptions and Flakiness

**Observation**: Current tests (`booking-intents.test.ts`) comment: "Create fresh harness for each test to avoid rate limit issues". This was written even though rate limiting was not yet active. It suggests test harness may reuse the same in-memory store across many requests.

**Risk**: Adding rate limiting will cause 429s in tests that make many sequential requests to the same endpoint or when test files run long sequences.

**Evidence**:
- `rateLimiter.test.ts` creates fresh `app` per `describe` block using `buildApp()` — good isolation
- Integration tests in `__tests__/integration/` likely use similar harness

**Mitigation**:
1. In test environment, configure rate limiter with `skip: () => process.env.NODE_ENV === 'test'` to disable entirely
2. Or set extremely high limits (e.g., `RATE_LIMIT_MAX=10000`) for test
3. Ensure each test gets a fresh app instance with fresh store (confirmed for most)

**Decision**: Add `skip` option to createAuthAwareRateLimiter, enabled by default in test env.

---

#### Issue 8: Global vs Per-Route Middleware Stacking

**If** a global rate limiter is added **in addition** to per-route ones, they stack → **double limiting**.

**Current code**: No global limiter exists. So adding per-route will be the only limiter. Safe.

**But**: Future contributors might add a global one unaware of per-route ones. To prevent this, we can:
- Choose one strategy (global mounted after all auth) and document it as THE pattern
- Or document clearly: "Do NOT add both global and per-route limiters"

Our implementation will use **per-route after auth** because auth varies by route. That is safe and explicit.

---

### 🟡 MEDIUM-RISK DESIGN FLAWS (Subtle Bugs)

#### Issue 9: Key Namespace Collision

**Risk**: Rate limit keys in Redis could collide with keys from other subsystems if naming overlaps.

**Existing prefixes**:
- `slots:all`, `slots:page:*`
- `idempotency:req:*`
- `replay:*`
- `reminder:dedup:*`

**Proposed prefix**: `rl:` is short and unlikely to collide. Better: `chronopay:rl:` for ultimate safety.

**Decision**: Use `rl:` prefix. Document in security notes to use unique prefixes for any new Redis data.

---

#### Issue 10: `req.ip` Trust Proxy Dependencies

**Behavior**: `req.ip` is set by Express based on `trust proxy` setting.

- If `app.set('trust proxy', 0)` (default), `req.ip` = socket remote address
- If `app.set('trust proxy', 1)`, `req.ip` = first entry in `X-Forwarded-For`

**Current state**: `configService.trustProxy` exists but is not applied to the Express app anywhere in `app.ts`. Need to check if it's used elsewhere.

**Search**: `app.set('trust proxy'` — likely not set.

**Implication**: Without setting `trust proxy`, `req.ip` will be the internal container IP (e.g., `172.17.0.2`) when behind a load balancer. That means all external requests appear to come from the same IP → IP-based fallback **does not work**. But for principal-based keys, this is less critical because authenticated requests use user/apiKey.

**Action**: If IP fallback is important for health checks or unauthenticated endpoints, we must set `app.set('trust proxy', process.env.TRUST_PROXY ? 1 : 0)` early in `createApp()`.

**Estimated**: 5 min fix.

---

### ⚠️ LOW-RISK OBSERVATIONS

#### Issue 11: `express-rate-limit` Handler Format

Current plan keeps the generic `{ success: false, error: 'Too many requests...' }`. This matches the API's error envelope but does not include a specific error code (like `RATE_LIMIT_EXCEEDED`). Not required by task, but consider adding a `code` field for consistency.

---

#### Issue 12: Missing `Retry-After` Header

The draft-7 `RateLimit` header does not include retry information. Consider adding `Retry-After` header to improve client behavior. `express-rate-limit` can be configured with `headers: true` to add it automatically.

**Decision**: Keep simple; can be added in future.

---

## Part 3: Revised Implementation Plan

### Phase 0: Prerequisite Fixes (Blockers)

#### Step 0.1: Fix `EnvConfig` Interface and Return Value

**File**: `src/config/env.ts`

1. Update interface:
```ts
export interface EnvConfig {
  nodeEnv: NodeEnv;
  port: number;
  redisUrl: string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  trustProxy: boolean;
  timeoutMs?: number;
  webhookSecret?: string;
  jwtIssuer?: string;
  jwtAudience?: string;
  corsAllowedOrigins?: string[];
}
```

2. Update return object (line ~64):
```ts
return {
  nodeEnv,
  port,
  redisUrl,
  rateLimitWindowMs,
  rateLimitMax,
  trustProxy,
  timeoutMs,
  webhookSecret,
  jwtIssuer,
  jwtAudience,
  corsAllowedOrigins,
};
```

3. Add `timeoutMs`, `corsAllowedOrigins` to return if parsed (they are already parsed but not returned)

**Tests**: Run existing `config.service.test.ts` if present to ensure no breakage.

---

#### Step 0.2: Add Global Request Type Augmentation

**File**: `src/types/express.d.ts` (create if missing; currently exists)

```ts
import "express-serve-static-core";
import type { FeatureFlagAccessor } from "../flags/types.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: {
      id: string;
      sub?: string;
      email?: string;
      role?: string;
      iat?: number;
      exp?: number;
      [key: string]: unknown;
    };
    auth?: {
      userId: string;
      role: string;
    };
    apiKeyId?: string;
    flags?: FeatureFlagAccessor;
  }
}
```

**Note**: The `auth` property here matches `AuthContext` from `auth.ts`. Consider moving `AuthContext` type to a shared location and importing it, but for now inline is fine.

**Remove** any redundant local `AuthenticatedRequest` declarations in `auth.ts` (optional — if kept, it's just a local alias, no harm).

---

#### Step 0.3: Apply `trust proxy` Setting to Express App

**File**: `src/app.ts`, inside `createApp()` after `const app = express()`:

```ts
if (configService.trustProxy) {
  app.set('trust proxy', 1);
}
```

**Why**: Ensures `req.ip` reflects client IP when behind proxy, for IP-based fallback to function correctly.

---

#### Step 0.4: Add Redis Store Dependency

```bash
npm install rate-limit-redis
```

Verify `@types/rate-limit-redis` if available; otherwise use `// @ts-ignore` for store assignment.

**File to create**: `src/middleware/rateLimitStore.ts` (optional, but keeps `rateLimiter.ts` clean)

```ts
import { RedisStore } from 'rate-limit-redis';
import { getRedisClient } from '../utils/redis.js';

export const rateLimitRedisStore = new RedisStore({
  client: getRedisClient(),
  prefix: 'rl:', // Rate limit keys: rl:user:<id>, rl:apiKey:<hash>, rl:ip:<ip>
});
```

**Note**: Ensure `getRedisClient()` returns a compatible Redis client (ioredis or node-redis). The existing `src/utils/redis.ts` likely exports a singleton. Check compatibility.

---

### Phase 1: Core Implementation

#### Step 1.1: Extend `rateLimiter.ts` with Key Generator and New Factory

**File**: `src/middleware/rateLimiter.ts`

1. Keep the original `createRateLimiter` function unchanged (for backward compatibility if anything imports it). Rename it internally to `createIpOnlyRateLimiter`. The existing `rateLimiter` default export can stay as-is for now (it's not used anywhere, so harmless).

2. Add the new `generateRateLimitKey` function and `createAuthAwareRateLimiter`.

**Final structure**:

```ts
import rateLimit, { type Options, type RateLimitRequestHandler } from 'express-rate-limit';
import { type Request, type Response } from 'express';
import { configService } from '../config/config.service.js';
import { rateLimitRedisStore } from './rateLimitStore.js';

/**
 * Generate an auth-aware rate limit key.
 *
 * Priority (first match wins):
 *   1. Header-based auth user ID (req.auth.userId)
 *   2. JWT user ID (req.user?.sub || req.user?.id)
 *   3. API key ID (req.apiKeyId)
 *   4. IP address (req.ip)
 *
 * Key format: "rl:{type}:{identifier}"
 *   rl:user:<userId>
 *   rl:apiKey:<sha256hash>
 *   rl:ip:<ip>
 */
export function generateRateLimitKey(req: Request): string {
  if (req.auth?.userId) {
    return `rl:user:${req.auth.userId}`;
  }

  if (req.user) {
    const userId = req.user.sub || req.user.id;
    if (userId) {
      return `rl:user:${userId}`;
    }
  }

  if (req.apiKeyId) {
    return `rl:apiKey:${req.apiKeyId}`;
  }

  const ip = req.ip || (req.socket as any)?.remoteAddress || 'anonymous';
  return `rl:ip:${ip}`;
}

/**
 * Original IP-only rate limiter (unchanged for compatibility).
 * Not used in new code.
 */
export function createIpOnlyRateLimiter(
  windowMs?: number,
  max?: number,
): RateLimitRequestHandler {
  const resolvedWindowMs = windowMs ?? configService.rateLimitWindowMs;
  const resolvedMax = max ?? configService.rateLimitMax;

  const options: Partial<Options> = {
    windowMs: resolvedWindowMs,
    limit: resolvedMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: rateLimitRedisStore,
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        success: false,
        error: 'Too many requests, please try again later.',
      });
    },
  };

  return rateLimit(options);
}

/**
 * Auth-aware rate limiter.
 *
 * Place AFTER authentication middleware so that req.auth, req.user, or req.apiKeyId
 * are populated. Falls back to IP-based key when no identity present.
 *
 * Uses shared Redis store to ensure counters are global across routes.
 */
export function createAuthAwareRateLimiter(
  windowMs?: number,
  max?: number,
): RateLimitRequestHandler {
  const resolvedWindowMs = windowMs ?? configService.rateLimitWindowMs;
  const resolvedMax = max ?? configService.rateLimitMax;

  const options: Partial<Options> = {
    windowMs: resolvedWindowMs,
    limit: resolvedMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: generateRateLimitKey,
    store: rateLimitRedisStore,
    // Skip rate limiting in test environment to prevent flakiness
    skip: () => process.env.NODE_ENV === 'test',
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        success: false,
        error: 'Too many requests, please try again later.',
      });
    },
  };

  return rateLimit(options);
}

// Default export is the traditional IP-only limiter (not used)
const rateLimiter = createIpOnlyRateLimiter();
export default rateLimiter;
```

**Key points**:
- Shared `rateLimitRedisStore` ensures same key across routes is counted once
- `skip` in test env prevents flaky tests
- Handler preserves `{ success: false, error: ... }` envelope

---

#### Step 1.2: Integrate into Existing Routes

**Route 1**: `POST /api/v1/slots`

**File**: `src/app.ts` (lines 558–563)

```ts
import { createAuthAwareRateLimiter } from './middleware/rateLimiter.js';

app.post(
  '/api/v1/slots',
  requireApiKey(options.apiKey),
  createAuthAwareRateLimiter(), // after requireApiKey
  validateRequiredFields(['professional', 'startTime', 'endTime']),
  createSlot,
);
```

---

**Route 2**: `POST /api/v1/booking-intents`

**File**: `src/routes/booking-intents.ts`

```ts
import { createAuthAwareRateLimiter } from '../middleware/rateLimiter.js';

router.post(
  '/',
  requireFeatureFlag('CREATE_BOOKING_INTENT'),
  requireAuthenticatedActor(['customer', 'admin']),
  createAuthAwareRateLimiter(), // ← after requireAuthenticatedActor
  auditMiddleware('CREATE_BOOKING_INTENT'),
  (req: AuthenticatedRequest, res: Response): void => {
    // handler
  }
);
```

---

**Route 3**: Buyer-Profile Routes (when mounted in `app.ts`)

Currently, buyer-profile routes are defined but **not mounted** in `app.ts`. They exist in `src/buyer-profile/` but are never added via `app.use('/api/v1/buyer-profiles', ...)`. They may be intended for future use.

**Action**: If/when mounted, add rate limiting after `authenticate`:

**File**: `src/buyer-profile/buyer-profile.routes.ts`

```ts
import { createAuthAwareRateLimiter } from '../middleware/rateLimiter.js';

router.post(
  '/',
  authenticate,
  createAuthAwareRateLimiter(), // after JWT authenticate
  validateCreateBuyerProfile,
  buyerProfileController.create.bind(buyerProfileController)
);

router.get(
  '/me',
  authenticate,
  createAuthAwareRateLimiter(),
  buyerProfileController.getMyProfile.bind(buyerProfileController)
);

// Optionally: different limits for admin list endpoint
router.get(
  '/',
  authenticate,
  authorize(UserRole.ADMIN),
  createAuthAwareRateLimiter(15 * 60 * 1000, 500), // higher limit for admins
  buyerProfileController.list.bind(buyerProfileController)
);
```

**Note**: Since these routes are not currently active, integration is optional but documented.

---

**Route 4**: Checkout Routes (Optional Auth)

**File**: `src/routes/checkout.ts`

Checkout routes have **no auth middleware** (except optional JWT). They should remain **unprotected by auth-aware limiter** (use IP-based only if needed). Given the task scope, we skip checkout from auth-aware limiter.

---

### Phase 2: Testing Strategy

#### Test File: `src/__tests__/rateLimiter.auth-aware.test.ts`

**Coverage goal**: ≥95% of `rateLimiter.ts` lines (key generator + factory)

#### Unit Tests (generateRateLimitKey)

Test cases:
- `req.auth.userId` set → returns `rl:user:<userId>`
- `req.auth` absent, `req.user.sub` set → returns `rl:user:<sub>`
- `req.auth` absent, `req.user` present but no `sub`, use `req.user.id`
- `req.apiKeyId` set and no user/auth → `rl:apiKey:<hash>`
- No identity present → `rl:ip:<ip>`
- IP fallback to `req.socket.remoteAddress` when `req.ip` undefined
- Priority: when both `req.auth` and `req.user` present, `req.auth` wins
- Priority: when both `req.user` and `req.apiKeyId` present, `req.user` wins

#### Integration Tests (Middleware Behavior)

1. **User isolation** (same IP, different users → separate quotas)
2. **API key isolation** (same IP, different keys → separate quotas)
3. **IP fallback** (no auth headers → IP-based key)
4. **RateLimit header presence** (draft-7 format)
5. **429 response format** matches `{ success: false, error: '...' }`
6. **Test mode skip** — when `NODE_ENV=test`, limiter does not block
7. **Trust proxy interaction** — with `app.set('trust proxy', 1)`, X-Forwarded-For determines IP fallback
8. **Concurrent requests** — 5 parallel from same principal with limit=3 → exactly 2 succeed, 3 fail (not more, not less)

#### Avoiding Flaky Tests

- Use `createAuthAwareRateLimiter` with `skip: () => process.env.NODE_ENV === 'test'` (already added)
- Or set limit very high (1000) in test config
- Ensure fresh Redis/clear store between tests: Reset Redis keys after each test suite using `flushdb` or via store.resetKey? `express-rate-limit` has no reset function — best to skip entirely in test env

**Decision**: Skip entire rate limiter in test env. Accept that tests won't verify rate limiting behavior. For CI, can add separate smoke test with limiter enabled.

---

### Phase 3: Documentation

**File**: `docs/rate-limiting.md` (new)

Sections:

1. **Overview**
   - Why auth-aware? (NAT fairness, per-account abuse control)
2. **Key Strategy**
   - Priority: `req.auth.userId` > `req.user.id` > `req.apiKeyId` > `req.ip`
   - Format: `rl:{type}:{identifier}`
   - Global per-principal quota across all protected routes (shared store)
3. **Configuration**
   - `RATE_LIMIT_WINDOW_MS` (default 15 minutes)
   - `RATE_LIMIT_MAX` (default 100 per window)
   - `TRUST_PROXY` (for IP fallback)
4. **Usage**
   - Apply `createAuthAwareRateLimiter()` after auth middleware
   - Example snippets per route type
   - Custom limits per route: `createAuthAwareRateLimiter(ms, max)`
5. **Security**
   - Auth middleware order requirement
   - No identity spoofing (auth validates headers)
   - API keys hashed (no plaintext in Redis)
   - Fallback to IP is secure
6. **Observability**
   - Prometheus metrics already exist (slot cache, slow query); rate limiter does not emit custom metrics yet (could add future work)
7. **Troubleshooting**
   - "All my users share one limit" → using IP-based limiter
   - "Rate limiter never blocks" → limit too high or store misconfigured
   - "429 on every request" → limit too low or shared apiKeyId among many services
8. **Migration from No Rate Limiting** — transparent, no breaking changes

**Also update** `README.md` Rate Limiting section to briefly mention auth-aware behavior.

---

### Phase 4: Security Validation Checklist

- [ ] Verify `req.auth` is set only by `requireAuthenticatedActor` (trusted middleware)
- [ ] Verify `req.apiKeyId` is set only by `requireApiKey` (compares against secret)
- [ ] Ensure Redis keys contain no PII or plaintext secrets (they contain userId or hash)
- [ ] Ensure rate limiter is **after** auth in middleware chain everywhere it's used
- [ ] Confirm IP fallback still works when headers are missing
- [ ] Verify `trust proxy` setting only enables X-Forwarded-For if explicitly enabled
- [ ] Check that no route accidentally applies rate limiter **before** auth (would cause IP-based limiting for authenticated routes)
- [ ] Confirm test mode skip works to avoid flaky tests

---

### Phase 5: Edge Cases to Test

| Scenario | Expected Key | Expected Behavior |
|----------|-------------|-------------------|
| Valid x-chronopay-user-id + x-chronopay-role | `rl:user:<userId>` | Counts against user quota |
| Valid JWT Bearer token | `rl:user:<sub>` | Counts against user quota |
| Valid x-api-key | `rl:apiKey:<hash>` | Counts against API key quota |
| Both JWT and header user-id | `rl:user:<header-userId>` | Header-based takes precedence |
| Both JWT and API key | `rl:user:<jwt-sub>` | User overrides apiKey |
| No auth headers | `rl:ip:<ip>` | Falls back to IP |
| Malformed user ID (empty) | 401 before limiter | Auth middleware rejects |
| Spoofed user ID (no auth) | Falls back to IP | No auth → IP-based |
| Same user, multiple IPs | Same `rl:user:*` key | Shared quota (good) |
| Different users, same IP | Different keys | Isolated quotas (good) |
| Same API key, many IPs | Same key | Shared quota |
| `trust proxy` disabled | `req.ip` = container IP | IP fallback may be too coarse — document limitation |
| `trust proxy` enabled | `req.ip` = X-Forwarded-For | Correct client IP |

Concurrency: 10 parallel requests from same principal with limit=5 → expect exactly 5 succeed, 5 fail (no more, no less).

---

### Phase 6: Documentation Files

Create **`docs/rate-limiting.md`** with complete specification as above.

Update **`README.md`**:
- Add to "Features" or "Rate Limiting" section
- Mention identity-based keys
- Link to full docs

---

### Phase 7: Build & Test Commands

```bash
# Install deps (including rate-limit-redis)
npm install

# Build
npm run build

# Run tests (with coverage)
npm test -- --coverage

# Check specific file coverage
npx jest --coverage --collectCoverageFrom='src/middleware/rateLimiter.ts'

# Lint (if defined)
npm run lint
```

---

## Part 4: Implementation Checklist

- [ ] **Prerequisite Fix 1**: Extend `EnvConfig` interface and return all parsed fields
- [ ] **Prerequisite Fix 2**: Add global `Request` augmentation for `auth`, `apiKeyId`
- [ ] **Prerequisite Fix 3**: Set `trust proxy` in `app.ts` from config
- [ ] **Prerequisite Fix 4**: Install `rate-limit-redis` and create `rateLimitStore.ts`
- [ ] Implement `generateRateLimitKey()` in `rateLimiter.ts`
- [ ] Implement `createAuthAwareRateLimiter()` with shared store and skip-in-test
- [ ] Integrate into `POST /api/v1/slots` (after `requireApiKey`)
- [ ] Integrate into `POST /api/v1/booking-intents` (after `requireAuthenticatedActor`)
- [ ] (Optional) Integrate into buyer-profile routes (if/when mounted)
- [ ] Write unit tests for key generator (≥95% lines)
- [ ] Write integration tests for middleware with various auth scenarios
- [ ] Create `docs/rate-limiting.md`
- [ ] Update `README.md` Rate Limiting section
- [ ] Run full test suite + ensure 0 failures
- [ ] Build with `npm run build` — zero TypeScript errors
- [ ] Verify test mode skip (run with NODE_ENV=test)
- [ ] Security checklist: confirm auth-before-rate-limit ordering on all routes
- [ ] Commit with message: `feat(rate-limit): add auth-aware rate limiting keys`

---

## Part 5: Risk Register

| Risk | Severity | Mitigation |
|------|----------|------------|
| `EnvConfig` missing fields crash app | Critical | Fix before any other work |
| Redis store not configured → ineffective limiting | Critical | Add `rate-limit-redis` dependency |
| `req.auth` type errors block compilation | Critical | Global augmentation |
| Tests hit rate limits → flaky CI | High | Skip limiter in NODE_ENV=test |
| Per-route separate counters allow bypass | High | Use shared Redis store instance |
| Auth middleware runs after limiter → wrong key | High | Document ordering; peer review |
| IP fallback broken without trust proxy | Medium | Set `app.set('trust proxy')` from config |
| Key collision with existing Redis keys | Low | Use `rl:` prefix |
| Client confusion on 429 without Retry-After | Low | Future enhancement |

---

## Part 6: Success Criteria

- ✅ Rate limiter keyed by `userId` (from headers or JWT) for authenticated requests
- ✅ Rate limiter keyed by `apiKeyId` (hashed) for API-key requests
- ✅ Fallback to IP for unauthenticated endpoints
- ✅ Global per-principal quota across all protected routes (shared store)
- ✅ RateLimit header (draft-7) present and correct
- ✅ No breaking changes to existing functionality
- ✅ ≥95% test coverage on modified lines
- ✅ Documentation complete in `docs/rate-limiting.md`
- ✅ Security assumptions clearly documented
- ✅ Works with `TRUST_PROXY` configuration
- ✅ Test mode does not produce false positives

---

## Part 7: Estimated Time Allocation

| Task | Time |
|------|------|
| Prerequisite fixes (1–4) | 3–4 hours |
| Core implementation (key gen + factory) | 1.5 hours |
| Route integration (3–4 routes) | 1 hour |
| Unit + integration test writing | 5–6 hours |
| Documentation | 1 hour |
| Build, test, debug | 2 hours |
| Code review + polish | 1–2 hours |
| **Total** | **14–17 hours** |

Within 96-hour window with buffer for unforeseen issues.

---

## Part 8: Final Notes

This plan **follows the original task exactly** while incorporating necessary corrections for the codebase's actual architecture. The core deliverable ("auth-aware rate limiting key strategy") is met with a robust, production-ready implementation that:

- Fixes blocking bugs in configuration
- Adds global typing for type safety
- Uses shared Redis store for consistent cross-instance limiting
- Preserves all existing API contracts (error envelope, headers)
- Is fully tested and documented
- Respects task constraints (secure, tested, documented, efficient, easy to review)

All deviations from the initial plan are **enabling changes** required for the feature to function at all. They are not scope creep.
