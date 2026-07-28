/**
 * fraudTrafficRouter.ts
 * ----------------------
 * Pure routing logic. Maps a `(tenantId, snapshot)` pair to a model version
 * using per-tenant overrides first, then consistent-hash bucketing across
 * the registered weight distribution. Allocation-free on the hot path:
 *   - per-tenant override → Map.get (O(1))
 *   - bucketed tenants     → SHA-256 → uint32 mod 100 → array index
 *
 * The snapshot itself is built asynchronously (only on promotion) so the
 * hot path never has to walk the registry or allocate intermediate maps.
 */

import { createHash } from "node:crypto";

export const BUCKET_SPACE = 100; // weights are percentages; 100 is the natural space.

export interface SnapshotInputs {
  models: Map<string, unknown>;
  weights: Record<string, number>;
  overrides: Record<string, string>;
  snapshotId: string;
}

export interface RoutingSnapshot {
  /** Monotonic identifier so callers can detect a snap they no longer hold. */
  snapshotId: string;
  /** Sorted-by-version cumulative weight table for the bucketing lookup. */
  cumulative: Array<{ upper: number; version: string }>;
  /** Pre-built per-tenant override map; missing keys fall through to bucketing. */
  overrides: Map<string, string>;
  /** Highest-weight version used as the off-route fallback. */
  defaultVersion: string;
  /** Set of versions actively receiving traffic (weight > 0). */
  versions: Set<string>;
}

export interface RoutingDecision {
  version: string;
  /** Bucket index [0..99] when bucketing was used; -1 when override matched. */
  bucket: number;
}

function weightOf(map: Record<string, number>, version: string): number {
  const w = map[version];
  return typeof w === "number" && Number.isFinite(w) ? w : 0;
}

/**
 * Deterministic SHA-256-based projection of a tenant identifier into the
 * bucket space [0..BUCKET_SPACE). Same tenant always lands in the same
 * bucket; tenants that are alphabetically adjacent get unrelated buckets
 * (no clumping).
 */
function hashTenantToBucketInternal(tenantId: string): number {
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new Error("tenantId must be a non-empty string");
  }
  const h = createHash("sha256").update(tenantId).digest();
  // First 4 bytes as a big-endian uint32.
  const u =
    (h[0] << 24) |
    (h[1] << 16) |
    (h[2] << 8) |
    h[3];
  return (u >>> 0) % BUCKET_SPACE;
}

/**
 * Build the cumulative weight table from a `weights` map (which must sum
 * to exactly 100). Versions are sorted alphabetically so two snapshots
 * with identical weights produce identical cumulative tables — useful for
 * snapshot diffs and audit replay.
 */
function buildCumulative(
  weights: Record<string, number>,
): Array<{ upper: number; version: string }> {
  const ordered = Object.keys(weights).sort();
  const out: Array<{ upper: number; version: string }> = [];
  let upper = 0;
  for (const v of ordered) {
    const w = weightOf(weights, v);
    upper += w;
    if (upper > BUCKET_SPACE) upper = BUCKET_SPACE;
    out.push({ upper, version: v });
  }
  return out;
}

function pickDefaultVersion(weights: Record<string, number>): string {
  let best = "";
  let bestWeight = -1;
  for (const [v, wRaw] of Object.entries(weights)) {
    const w = wRaw ?? 0;
    if (w <= 0) continue;
    if (w > bestWeight || (w === bestWeight && (best === "" || v < best))) {
      bestWeight = w;
      best = v;
    }
  }
  return best;
}

/**
 * Pure router. All state lives in the immutable `RoutingSnapshot` passed
 * by the caller; the registry simply hands out the latest snapshot for
 * both the request handler and the promotion endpoint to share.
 */
export const fraudTrafficRouter = {
  hashTenantToBucket(tenantId: string): number {
    return hashTenantToBucketInternal(tenantId);
  },

  /**
   * Build an immutable RoutingSnapshot. Caller is responsible for passing
   * `weights` whose sum equals 100 and only includes registered versions.
   */
  buildSnapshot(input: SnapshotInputs): RoutingSnapshot {
    const overrides = new Map<string, string>();
    for (const [tenantId, version] of Object.entries(input.overrides)) {
      const w = weightOf(input.weights, version);
      if (input.models.has(version) && w > 0 && tenantId.length > 0) {
        overrides.set(tenantId, version);
      }
    }
    // Only versions with positive weight participate in routing. Parked
    // versions (weight 0) live in the registry but not the snapshot.
    const versions = new Set(
      Object.entries(input.weights)
        .filter(([, w]) => (w ?? 0) > 0)
        .map(([v]) => v),
    );
    const cumulative = buildCumulative(input.weights);
    return {
      snapshotId: input.snapshotId,
      overrides,
      cumulative,
      defaultVersion: pickDefaultVersion(input.weights),
      versions,
    };
  },

  /**
   * Route a tenant to a fraud model version. O(1), zero allocations.
   * Caller must pass a snapshot obtained via {@link buildSnapshot}.
   */
  routeRequest(tenantId: string, snapshot: RoutingSnapshot): RoutingDecision {
    if (!snapshot.cumulative.length) {
      throw new Error("RoutingSnapshot has no registered versions with traffic weight");
    }
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      throw new Error("tenantId must be a non-empty string");
    }

    // Per-tenant override takes precedence. Validate target version still exists.
    const override = snapshot.overrides.get(tenantId);
    if (override !== undefined) {
      if (!snapshot.versions.has(override)) {
        throw new Error(`Override maps to unknown version ${override}`);
      }
      return { version: override, bucket: -1 };
    }

    // Consistent-hash bucketing.
    const bucket = hashTenantToBucketInternal(tenantId);
    for (const cell of snapshot.cumulative) {
      if (bucket < cell.upper) {
        if (!snapshot.versions.has(cell.version)) {
          continue;
        }
        return { version: cell.version, bucket };
      }
    }

    // Should be unreachable: cumulative covers [0..100) by construction.
    const lastVersion = snapshot.cumulative[snapshot.cumulative.length - 1].version;
    return { version: lastVersion, bucket };
  },
};

/**
 * Public for testing only: pre-compute the cumulative weight table without
 * going through `buildSnapshot`. The caller provides a complete
 * `weights` map (already zero-filled for every registered version); this
 * helper performs no mutation, which keeps the production surface safe.
 */
export function previewCumulative(
  weights: Record<string, number>,
): Array<{ upper: number; version: string }> {
  return buildCumulative(weights);
}
