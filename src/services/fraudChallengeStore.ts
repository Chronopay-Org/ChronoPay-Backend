/**
 * @file src/services/fraudChallengeStore.ts
 *
 * One-time store for anti-fraud step-up challenge tokens (issue #1345).
 *
 * When the fraud wall blocks a request in challenge mode it returns a
 * `challengeToken` in the 403 payload. The token is only useful if the blocked
 * client can present it again and prove who they are, so every issued token is
 * persisted here, bound to:
 *
 *   - the actor that was blocked (`actorId`), and
 *   - a hash of the request body the block was computed for (`bodyHash`),
 *
 * and it expires after a short TTL. A retry that presents the token *and* a
 * fresh MFA proof consumes the entry: the step-up block is bypassed exactly
 * once, and any reuse finds nothing left to consume.
 */

import { createHash, randomUUID } from "node:crypto";

/** Why a presented challenge token was refused. */
export type FraudChallengeRejection =
  /** No entry for the token (never issued, already consumed, or unknown). */
  | "unknown"
  /** The entry outlived its TTL and is no longer redeemable. */
  | "expired"
  /** The token was issued to a different actor. */
  | "actor_mismatch"
  /** The retry body differs from the body the block was computed for. */
  | "body_mismatch";

interface FraudChallengeEntry {
  actorId: string;
  bodyHash: string;
  expiresAt: number;
}

/** Default lifetime of a challenge token: 10 minutes. */
const DEFAULT_CHALLENGE_TTL_MS = 10 * 60 * 1000;

function resolveTtlMs(): number {
  const raw = Number(process.env.FRAUD_CHALLENGE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CHALLENGE_TTL_MS;
}

/**
 * Deterministic JSON: object keys are sorted recursively so a retried request
 * with the same fields in a different order still hashes identically.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(",")}}`;
}

/** Stable SHA-256 over the (parsed) request body a challenge is bound to. */
export function hashRequestBody(body: unknown): string {
  return createHash("sha256").update(stableStringify(body ?? null)).digest("hex");
}

export class FraudChallengeStore {
  private readonly store = new Map<string, FraudChallengeEntry>();

  /** Injectable clock so expiry can be tested without waiting on wall time. */
  constructor(private readonly nowMs: () => number = Date.now) {}

  /** Issues a token for a blocked actor and returns it with its expiry. */
  issue(actorId: string, bodyHash: string): { token: string; expiresAt: number } {
    const token = randomUUID();
    const expiresAt = this.nowMs() + resolveTtlMs();
    this.store.set(token, { actorId, bodyHash, expiresAt });
    return { token, expiresAt };
  }

  /**
   * Non-mutating validation of a presented token. Returns `null` when the
   * token may be redeemed, otherwise the reason it may not.
   */
  check(token: string, actorId: string, bodyHash: string): FraudChallengeRejection | null {
    const entry = this.store.get(token);
    if (!entry) {
      return "unknown";
    }
    if (entry.expiresAt <= this.nowMs()) {
      return "expired";
    }
    if (entry.actorId !== actorId) {
      return "actor_mismatch";
    }
    if (entry.bodyHash !== bodyHash) {
      return "body_mismatch";
    }
    return null;
  }

  /** Redeems (deletes) a token. Returns false when it was not present. */
  consume(token: string): boolean {
    return this.store.delete(token);
  }

  _reset(): void {
    this.store.clear();
  }
}

/** Process-wide store backing the fraud wall's challenge flow. */
export const fraudChallengeStore = new FraudChallengeStore();
