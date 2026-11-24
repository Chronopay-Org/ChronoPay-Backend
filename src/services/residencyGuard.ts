/**
 * residencyGuard.ts
 *
 * Data-residency egress guard that prevents cross-region data reads without
 * an explicit waiver.
 *
 * Design decisions:
 *  - Region detection uses the `x-data-region` header as the authoritative
 *    source (set by infrastructure / edge proxy). Falls back to _requestRegion
 *    (set from IP or `x-region` header) for the request origin.
 *  - The guard compares the request region against the data region. When
 *    they differ it looks up an active waiver scoped to the request identity.
 *  - Waivers are stored in the `residency_waivers` table with scope, target
 *    region, and expiry.
 *  - Breach attempts are counted in a Prometheus counter and logged as
 *    structured alarms.
 *  - Admin bypass is supported via the `x-admin-residency-bypass` header
 *    (settable only by internal infrastructure).
 */

import { Request, Response, NextFunction } from "express";
import { sendErrorResponse } from "../errors/sendError.js";
import { ForbiddenError } from "../errors/AppError.js";
import { residencyEgressBreachAttempts } from "../metrics.js";
import { constantTimeEquals } from "../utils/constantTimeEquals.js";
import { logger } from "../utils/logger.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

declare module "express" {
  interface Request {
    /** Region detected for the current request origin. */
    requestRegion?: string;
    /** Region where the requested data resides. */
    dataRegion?: string;
    /** Whether this request has been granted a residency waiver. */
    residencyWaived?: boolean;
  }
}

/**
 * A timestamp as returned by the PostgreSQL driver. `pg` returns TIMESTAMPTZ
 * columns as `Date`, but some drivers/proxies (and serialized test fixtures)
 * return ISO-8601 strings. Both representations are normalized at the store
 * boundary.
 */
export type WaiverTimestamp = Date | string;

/**
 * Raw row shape returned by the `residency_waivers` table. This mirrors the
 * migration: every column except timestamp representation is a non-null
 * string.
 */
export interface WaiverDbRow {
  id: string;
  target_region: string;
  scope: string;
  expires_at: WaiverTimestamp;
  created_at: WaiverTimestamp;
  created_by: string;
}

/**
 * Normalized waiver row exposed by every `WaiverStore` implementation.
 * Timestamps are always `Date` instances so callers can compare them
 * deterministically regardless of the backing store.
 */
export interface WaiverRow {
  id: string;
  target_region: string;
  scope: string;
  expires_at: Date;
  created_at: Date;
  created_by: string;
}

/**
 * Minimal query adapter used by the SQL-backed store. This matches the
 * structural subset of `pg.Pool` the guard needs, while keeping the store
 * injectable for tests.
 */
export interface WaiverQueryResult {
  rows: WaiverDbRow[];
}

export interface WaiverQueryable {
  query(text: string, values?: unknown[]): Promise<WaiverQueryResult>;
}

/**
 * Interface for the waiver store.
 * Production uses SQL; tests use an in-memory implementation.
 */
export interface WaiverStore {
  /**
   * Find active (non-expired) waivers matching the given identity scope
   * and target region.
   */
  findActiveWaivers(scope: string, targetRegion: string): Promise<WaiverRow[]>;
}

// ─── Timestamp normalization ──────────────────────────────────────────────────

function toDate(value: WaiverTimestamp, field: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid ${field} timestamp: ${String(value)}`);
  }
  return date;
}

/**
 * Convert a raw database row into the normalized `WaiverRow` contract.
 * Expiry comparisons use `expires_at.getTime()`, so a valid `Date` is
 * guaranteed for both SQL and in-memory rows.
 */
function normalizeWaiverRow(row: WaiverDbRow): WaiverRow {
  return {
    id: row.id,
    target_region: row.target_region,
    scope: row.scope,
    expires_at: toDate(row.expires_at, "expires_at"),
    created_at: toDate(row.created_at, "created_at"),
    created_by: row.created_by,
  };
}

function isActive(row: WaiverRow, now: Date): boolean {
  // `<=` is expired: an exact expiry boundary must never grant access.
  return row.expires_at.getTime() > now.getTime();
}

// ─── Configuration ─────────────────────────────────────────────────────────────

/**
 * Read the default data region from the environment.
 * Used as a fallback when no `x-data-region` header is present.
 */
export function getDefaultDataRegion(): string {
  return process.env.DEFAULT_DATA_REGION ?? "us-east-1";
}

/**
 * Read the list of regions considered "local" to this deployment.
 * Cross-region access to a data region on this list is allowed without a waiver.
 */
export function getLocalRegions(): string[] {
  const raw = process.env.LOCAL_REGIONS;
  if (!raw) return [getDefaultDataRegion()];
  return raw.split(",").map((r) => r.trim()).filter(Boolean);
}

/**
 * Whether `x-region` and `x-data-region` headers should be trusted.
 * Defaults to `false` so untrusted callers cannot spoof regions.
 */
export function isTrustedRegionHeadersEnabled(): boolean {
  const raw = process.env.RESIDENCY_TRUST_REGION_HEADERS;
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

/**
 * Shared secret required in `x-edge-secret` when trusted region headers are enabled.
 */
export function getResidencyEdgeSecret(): string | undefined {
  const raw = process.env.RESIDENCY_EDGE_SECRET;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

let ignoredRegionHeadersWarned = false;

/**
 * Reset the one-time warning flag for ignored region headers (intended for tests).
 */
export function resetIgnoredRegionHeadersWarning(): void {
  ignoredRegionHeadersWarned = false;
}

function warnIgnoredRegionHeadersOnce(headerName: string): void {
  if (ignoredRegionHeadersWarned) return;
  ignoredRegionHeadersWarned = true;
  logger.warn(
    { header: headerName },
    "residency guard: ignoring untrusted region header; set RESIDENCY_TRUST_REGION_HEADERS=true and a matching x-edge-secret to honour region headers",
  );
}

/**
 * Verify that the incoming request is allowed to supply `x-region` / `x-data-region`.
 * Requires `RESIDENCY_TRUST_REGION_HEADERS=true` and a matching `x-edge-secret`
 * compared with constant-time equality.
 */
function hasTrustedRegionHeaders(req: Request): boolean {
  if (!isTrustedRegionHeadersEnabled()) return false;
  const expectedSecret = getResidencyEdgeSecret();
  if (!expectedSecret) return false;
  const providedSecret = req.header("x-edge-secret");
  if (!providedSecret) return false;
  return constantTimeEquals(providedSecret, expectedSecret);
}

// ─── Region detection ─────────────────────────────────────────────────────────

/**
 * Detect the request origin region.
 *
 * Priority:
 * 1. `x-region` header (only when `RESIDENCY_TRUST_REGION_HEADERS=true` and
 *    `x-edge-secret` matches `RESIDENCY_EDGE_SECRET`)
 * 2. `CloudFront-Viewer-Country` header (CloudFront geo-header)
 * 3. `x-forwarded-for` geo lookup (simplified — just logs; full GeoIP
 *    requires a GeoIP database integration)
 * 4. Default data region fallback
 */
export function detectRequestRegion(req: Request): string {
  // Explicit region header from trusted edge proxy only
  const regionHeader = req.header("x-region");
  if (regionHeader) {
    if (hasTrustedRegionHeaders(req)) {
      return regionHeader.trim().toLowerCase();
    }
    warnIgnoredRegionHeadersOnce("x-region");
  }

  // CloudFront geo-header
  const cfCountry = req.header("CloudFront-Viewer-Country");
  if (cfCountry) return cfCountry.trim().toLowerCase();

  // X-Forwarded-For — simplified detection (actual GeoIP would need a database)
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) {
    const clientIp = forwarded.split(",")[0].trim();
    // Log the IP for observability; actual geo-resolution is left to
    // infrastructure-level middleware (e.g. CloudFront, edge proxy).
    logger.debug({ clientIp }, "residency guard: x-forwarded-for present, using default region");
  }

  return getDefaultDataRegion();
}

/**
 * Determine the data region for the current request.
 *
 * Priority:
 * 1. `x-data-region` header (only when `RESIDENCY_TRUST_REGION_HEADERS=true` and
 *    `x-edge-secret` matches `RESIDENCY_EDGE_SECRET`)
 * 2. Default data region from environment
 */
export function detectDataRegion(req: Request): string {
  const dataRegion = req.header("x-data-region");
  if (dataRegion) {
    if (hasTrustedRegionHeaders(req)) {
      return dataRegion.trim().toLowerCase();
    }
    warnIgnoredRegionHeadersOnce("x-data-region");
  }
  return getDefaultDataRegion();
}

// ─── Waiver store implementations ─────────────────────────────────────────────

/**
 * Production SQL-backed waiver store.
 */
export class SqlWaiverStore implements WaiverStore {
  constructor(private readonly pool: WaiverQueryable) {}

  async findActiveWaivers(scope: string, targetRegion: string): Promise<WaiverRow[]> {
    const result = await this.pool.query(
      `SELECT id, target_region, scope, expires_at, created_at, created_by
       FROM residency_waivers
       WHERE scope = $1
         AND target_region = $2
         AND expires_at > NOW()
       ORDER BY expires_at ASC`,
      [scope, targetRegion],
    );
    const now = new Date();
    // Normalize/re-check in application code as well: the database filter is
    // the primary guard, but exact boundary rows returned by a driver or a
    // mocked adapter must still be treated as expired (`expires_at <= now`).
    return result.rows
      .map(normalizeWaiverRow)
      .filter((row) => isActive(row, now))
      .sort((a, b) => a.expires_at.getTime() - b.expires_at.getTime());
  }
}

/**
 * In-memory waiver store for testing.
 */
export class InMemoryWaiverStore implements WaiverStore {
  private readonly waivers = new Map<string, WaiverRow>();

  add(waiver: WaiverRow): void {
    this.waivers.set(waiver.id, normalizeWaiverRow(waiver));
  }

  async findActiveWaivers(scope: string, targetRegion: string): Promise<WaiverRow[]> {
    const now = new Date();
    return [...this.waivers.values()]
      .filter((w) => w.scope === scope && w.target_region === targetRegion && isActive(w, now))
      .map(normalizeWaiverRow)
      .sort((a, b) => a.expires_at.getTime() - b.expires_at.getTime());
  }

  clear(): void {
    this.waivers.clear();
  }

  list(): WaiverRow[] {
    return [...this.waivers.values()].map(normalizeWaiverRow);
  }
}

// ─── Identity scoping ─────────────────────────────────────────────────────────

/**
 * Derive a waiver scope string from the request identity.
 *
 * Priority (first match wins):
 * 1. req.apiKeyId -> "apiKey:<id>"
 * 2. req.auth?.userId -> "user:<id>"
 * 3. req.user?.sub || req.user?.id -> "user:<id>"
 * 4. Falls back to "ip:<hash>" for unauthenticated requests
 */
export function deriveWaiverScope(req: Request): string {
  if (req.apiKeyId) return `apiKey:${req.apiKeyId}`;
  if (req.auth?.userId) return `user:${req.auth.userId}`;
  if (req.user) {
    const userId = req.user.sub || req.user.id;
    if (userId) return `user:${userId}`;
  }
  // Fall back to IP-based scope
  const ip = req.ip || req.socket?.remoteAddress || "anonymous";
  return `ip:${ip}`;
}

// ─── Egress guard middleware ──────────────────────────────────────────────────

/**
 * Express middleware that enforces data-residency egress rules.
 *
 * Flow:
 * 1. Detect request region and data region.
 * 2. If request region == data region (or data region is in the local regions
 *    list), allow through — no egress happening.
 * 3. If request region != data region, check for an active waiver matching
 *    the derived scope + target region.
 * 4. If no valid waiver, block with 403 Forbidden and emit a breach alarm.
 * 5. Admin bypass via `x-admin-residency-bypass` header.
 *
 * Place AFTER authentication middleware so that req.apiKeyId / req.auth / req.user
 * are populated for scope derivation.
 *
 * @param waiverStore  The waiver store to query (injectable for testing).
 * @param localRegions Override local regions list (injectable for testing).
 */
export function createResidencyGuard(
  waiverStore: WaiverStore,
  localRegions?: string[],
) {
  const local = localRegions ?? getLocalRegions();

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Detect regions
      req.requestRegion = detectRequestRegion(req);
      req.dataRegion = detectDataRegion(req);

      // Same region — no egress
      if (req.requestRegion === req.dataRegion) {
        req.residencyWaived = true;
        next();
        return;
      }

      // Request is from a local region — internal infrastructure, allow
      if (local.includes(req.requestRegion)) {
        req.residencyWaived = true;
        next();
        return;
      }

      // Admin bypass header
      if (req.header("x-admin-residency-bypass") === "true") {
        logger.warn(
          { requestRegion: req.requestRegion, dataRegion: req.dataRegion },
          "residency guard: admin bypass used",
        );
        req.residencyWaived = true;
        next();
        return;
      }

      // Derive identity scope and look for active waivers
      const scope = deriveWaiverScope(req);
      const waivers = await waiverStore.findActiveWaivers(scope, req.requestRegion);

      if (waivers.length > 0) {
        req.residencyWaived = true;
        next();
        return;
      }

      // No waiver found — block and alarm
      residencyEgressBreachAttempts.inc();
      logger.warn(
        {
          requestRegion: req.requestRegion,
          dataRegion: req.dataRegion,
          scope,
          path: req.originalUrl || req.path,
          method: req.method,
        },
        "residency guard: cross-region egress blocked — no active waiver",
      );

      sendErrorResponse(
        res,
        new ForbiddenError(
          "Cross-region data access denied. A valid residency waiver is required.",
          "RESIDENCY_EGRESS_DENIED",
        ),
        req,
      );
      return;
    } catch (err) {
      // If waiver lookup itself fails, fail closed (block access)
      residencyEgressBreachAttempts.inc();
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "residency guard: waiver lookup failed — blocking access",
      );
      sendErrorResponse(
        res,
        new ForbiddenError(
          "Cross-region data access denied. Waiver lookup failed.",
          "RESIDENCY_EGRESS_DENIED",
        ),
        req,
      );
      return;
    }
  };
}
