import { createHash } from "node:crypto";
import type { Request } from "express";

const IDEMPOTENCY_STORAGE_PREFIX = "idempotency:req:";

/**
 * Derive the caller-identity namespace for an idempotency storage key.
 *
 * Priority (first match wins). Only verified auth state is trusted — never raw
 * request headers:
 *   1. `req.auth?.userId`  — attached by requireAuth()/requireAuthenticatedActor()
 *   2. `req.user?.sub || req.user?.id` — verified JWT payload
 *   3. `req.apiKeyId`      — attached by apiKeyAuth
 *   4. hashed client IP    — anonymous callers keep working exactly as before,
 *                            but are isolated per network origin.
 *
 * The principal *type* (`user:` / `apiKey:` / `ip:`) is part of the namespace so
 * different principal types can never collide with each other.
 */
export function deriveIdempotencyPrincipal(req: Request): string {
  if (req.auth?.userId) {
    return `user:${req.auth.userId}`;
  }

  if (req.user) {
    const jwtUserId = req.user.sub || req.user.id;
    if (jwtUserId) {
      return `user:${jwtUserId}`;
    }
  }

  if (req.apiKeyId) {
    return `apiKey:${req.apiKeyId}`;
  }

  // Hash the IP so IPv6 detection quirks and raw addresses never appear in
  // Redis keys, mirroring the auth-aware rate limiter.
  const ip = req.ip || req.socket?.remoteAddress || "anonymous";
  return `ip:${createHash("sha256").update(ip, "utf8").digest("hex")}`;
}

/**
 * Derive the route namespace for an idempotency storage key: the matched route
 * pattern (`req.baseUrl + req.route.path`, e.g. `/api/v1/checkout/sessions`)
 * without the query string. Falls back to the request path (originalUrl minus
 * the query) when the middleware runs outside a matched route.
 */
export function deriveIdempotencyRoute(req: Request): string {
  const matchedPattern = readMatchedRoutePattern(req);
  const raw = matchedPattern ? `${req.baseUrl}${matchedPattern}` : req.originalUrl.split("?")[0];
  return normalizeRoutePath(raw);
}

/**
 * Build the Redis storage key for an idempotency state entry.
 *
 * The key hashes the caller principal, HTTP method, matched route and the raw
 * `Idempotency-Key` together so that:
 *   - two different callers reusing the same key value never see each other's
 *     cached responses (cross-tenant replay), and
 *   - the same key value on two different routes never collides.
 *
 * SHA-256 keeps the stored key bounded in length and keeps user IDs, IPs and
 * raw key material out of Redis key names. All callers sharing a namespace
 * deterministically derive the same key, so replay semantics are unchanged for
 * a single caller.
 */
export function buildIdempotencyStorageKey(req: Request, idempotencyKey: string): string {
  const namespacedParts = [
    deriveIdempotencyPrincipal(req),
    req.method,
    deriveIdempotencyRoute(req),
    idempotencyKey,
  ];

  const digest = createHash("sha256")
    .update(JSON.stringify(namespacedParts), "utf8")
    .digest("hex");

  return `${IDEMPOTENCY_STORAGE_PREFIX}${digest}`;
}

function readMatchedRoutePattern(req: Request): string | undefined {
  const pattern: unknown = req.route?.path;
  if (typeof pattern === "string") {
    return pattern;
  }
  if (Array.isArray(pattern)) {
    return pattern.join("|");
  }
  return undefined;
}

function normalizeRoutePath(path: string): string {
  const stripped = path.replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped;
}
