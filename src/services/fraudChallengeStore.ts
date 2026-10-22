/**
 * @file src/services/fraudChallengeStore.ts
 *
 * Persistence for step-up challenge tokens issued by the anti-fraud wall.
 *
 * When `POST /api/v1/booking-intents` is blocked in challenge mode, the 403
 * response carries a `challengeToken`. The token is persisted here — bound to
 * the blocked actor and to a hash of the request body — so the client can
 * retry the *same* request once it has proven step-up authentication via MFA.
 *
 * Guarantees:
 *  - single-use: a successful `consume` deletes the token, so a retry that
 *    already bypassed the wall cannot replay it;
 *  - actor-bound: another authenticated actor presenting the token is rejected;
 *  - payload-bound: the token only validates against the body hash it was
 *    issued for, so it cannot be moved to a different intent payload;
 *  - expiring: tokens live at most `ttlMs` (default `FRAUD_CHALLENGE_TTL_MS`,
 *    15 minutes, aligned with the global MFA freshness window).
 *
 * The default implementation is in-process. `antiFraudScoring` accepts an
 * injectable {@link FraudChallengeStore}, so a Redis-backed store can be
 * swapped in for multi-process deployments without touching the middleware.
 */

import { createHash } from "node:crypto";

/** Values a token is bound to at issue time. */
export interface FraudChallengeBindings {
  /** Authenticated actor the blocked request belonged to. */
  actorId: string;
  /** SHA-256 of the canonicalised request body (see {@link hashFraudChallengeBody}). */
  bodyHash: string;
}

/** A stored challenge token. */
export interface IssuedFraudChallenge extends FraudChallengeBindings {
  issuedAt: number;
  expiresAt: number;
}

export type FraudChallengeRejectionReason =
  | "unknown"
  | "expired"
  | "actor_mismatch"
  | "body_mismatch";

export type FraudChallengeConsumeResult =
  | { ok: true; record: IssuedFraudChallenge }
  | { ok: false; reason: FraudChallengeRejectionReason };

/**
 * Persistence contract for issued challenge tokens. Implementations must make
 * `consume` atomic: only a fully valid consumption may delete the token, and
 * the same token must never validate twice.
 */
export interface FraudChallengeStore {
  issue(token: string, bindings: FraudChallengeBindings): void;
  consume(token: string, bindings: FraudChallengeBindings): FraudChallengeConsumeResult;
}

/** Default lifetime of an issued challenge token (ms). */
export const DEFAULT_CHALLENGE_TTL_MS = 15 * 60 * 1000;

function resolveTtlMs(): number {
  const raw = process.env.FRAUD_CHALLENGE_TTL_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_CHALLENGE_TTL_MS;
  }
  const configured = Number(raw);
  return Number.isFinite(configured) ? configured : DEFAULT_CHALLENGE_TTL_MS;
}

/**
 * Deterministic JSON encoding: object keys are sorted recursively so two
 * semantically identical bodies hash the same regardless of key order.
 * `undefined` normalises to `null` so the input's presence is stable.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = canonicalise(source[key]);
    }
    return out;
  }
  return value ?? null;
}

/**
 * SHA-256 over the canonicalised request body. Computed identically at issue
 * and retry time; any payload change produces a different hash and invalidates
 * the token.
 */
export function hashFraudChallengeBody(body: unknown): string {
  const json = JSON.stringify(canonicalise(body ?? null)) ?? "null";
  return createHash("sha256").update(json).digest("hex");
}

/**
 * In-process {@link FraudChallengeStore} with per-token expiry.
 *
 * Expired entries are swept on every `issue` so memory stays bounded by the
 * number of live tokens. Pass `now` in tests to control the clock, or a
 * negative `ttlMs` to make freshly issued tokens immediately expired.
 */
export class InMemoryFraudChallengeStore implements FraudChallengeStore {
  private readonly records = new Map<string, IssuedFraudChallenge>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? resolveTtlMs();
    this.now = options.now ?? Date.now;
  }

  issue(token: string, bindings: FraudChallengeBindings): void {
    this.sweep();
    const issuedAt = this.now();
    this.records.set(token, {
      ...bindings,
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
    });
  }

  consume(token: string, bindings: FraudChallengeBindings): FraudChallengeConsumeResult {
    const record = this.records.get(token);
    if (!record) {
      return { ok: false, reason: "unknown" };
    }
    if (this.now() >= record.expiresAt) {
      // Expired: drop it so a later replay reports "unknown", not "expired".
      this.records.delete(token);
      return { ok: false, reason: "expired" };
    }
    // Rejections that are not the presenter's fault (wrong actor / body) do
    // not burn the token: the legitimate owner must still be able to retry.
    if (record.actorId !== bindings.actorId) {
      return { ok: false, reason: "actor_mismatch" };
    }
    if (record.bodyHash !== bindings.bodyHash) {
      return { ok: false, reason: "body_mismatch" };
    }
    this.records.delete(token);
    return { ok: true, record };
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, record] of this.records) {
      if (now >= record.expiresAt) {
        this.records.delete(token);
      }
    }
  }
}
