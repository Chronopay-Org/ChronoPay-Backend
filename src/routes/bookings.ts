/**
 * @file src/routes/bookings.ts
 *
 * Express router for the /api/v1/bookings resource.
 *
 * GET /api/v1/bookings/search
 *   Searches booking records for the authenticated caller. This endpoint is
 *   the primary read path for dashboards and partner syncs, so it is the
 *   highest-traffic GET in the service — and therefore the first endpoint
 *   moved off the coarse global fixed-window limiter onto a per-tenant
 *   leaky bucket (60 rps sustained, 120 burst) keyed by trusted tenant
 *   identity. One noisy tenant can now only throttle itself, never the
 *   shared search path. See:
 *     - src/middleware/tenantLeakyBucket.ts (implementation)
 *     - docs/api/bookings-search.md (operator + client documentation)
 *
 * Query params:
 *   q        - free-text match over id, slotId, professional, note (case-insensitive)
 *   status   - exact booking status filter
 *   slotId   - exact slot filter
 *   from/to  - ISO-8601 datetimes; only bookings overlapping [from, to] are returned
 *   limit    - page size, 1..100 (default 50)
 *   offset   - page offset, >= 0 (default 0)
 *
 * Response: { success, data: { results, total, limit, offset } }
 * Rate-limited responses: 429 + Retry-After header + { success: false, error, retryAfter }.
 */

import { Router, type Request, type RequestHandler, type Response } from "express";
import { requireAuthenticatedActor } from "../middleware/auth.js";
import { createTenantLeakyBucketRateLimiter } from "../middleware/tenantLeakyBucket.js";
import {
  InMemoryBookingIntentRepository,
  type BookingIntentRecord,
  type BookingIntentStatus,
} from "../modules/booking-intents/booking-intent-repository.js";
import { logger } from "../utils/logger.js";

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "confirmed",
  "firm",
  "cancelled",
  "expired",
  "hold_placed",
  "hold_refunded",
]);

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

export interface BookingsRouterOptions {
  /** Override the rate limiter (tests). Defaults to the per-tenant leaky bucket (60 rps / 120 burst). */
  rateLimiter?: RequestHandler;
  /** Override the repository (tests / DB-backed wiring). */
  repository?: InMemoryBookingIntentRepository;
}

interface ParsedSearchQuery {
  q?: string;
  status?: BookingIntentStatus;
  slotId?: string;
  fromMs?: number;
  toMs?: number;
  limit: number;
  offset: number;
}

type QueryParseResult =
  | { ok: true; query: ParsedSearchQuery }
  | { ok: false; status: number; error: string };

function parseSearchQuery(req: Request): QueryParseResult {
  const raw = req.query;

  const q = typeof raw.q === "string" ? raw.q.trim() : undefined;
  if (q !== undefined && q.length > 200) {
    return { ok: false, status: 400, error: "q must be at most 200 characters" };
  }

  let status: BookingIntentStatus | undefined;
  if (typeof raw.status === "string" && raw.status.trim()) {
    const candidate = raw.status.trim().toLowerCase();
    if (!VALID_STATUSES.has(candidate)) {
      return {
        ok: false,
        status: 400,
        error: `status must be one of: ${[...VALID_STATUSES].join(", ")}`,
      };
    }
    status = candidate as BookingIntentStatus;
  }

  const slotId = typeof raw.slotId === "string" && raw.slotId.trim() ? raw.slotId.trim() : undefined;

  let fromMs: number | undefined;
  if (typeof raw.from === "string" && raw.from.trim()) {
    fromMs = Date.parse(raw.from);
    if (Number.isNaN(fromMs)) {
      return { ok: false, status: 400, error: "from must be a valid ISO 8601 datetime" };
    }
  }

  let toMs: number | undefined;
  if (typeof raw.to === "string" && raw.to.trim()) {
    toMs = Date.parse(raw.to);
    if (Number.isNaN(toMs)) {
      return { ok: false, status: 400, error: "to must be a valid ISO 8601 datetime" };
    }
  }

  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
    return { ok: false, status: 400, error: "from must not be after to" };
  }

  let limit = DEFAULT_LIMIT;
  if (raw.limit !== undefined) {
    limit = Number.parseInt(String(raw.limit), 10);
    if (!Number.isFinite(limit) || limit < 1 || limit > MAX_LIMIT) {
      return { ok: false, status: 400, error: `limit must be between 1 and ${MAX_LIMIT}` };
    }
  }

  let offset = 0;
  if (raw.offset !== undefined) {
    offset = Number.parseInt(String(raw.offset), 10);
    if (!Number.isFinite(offset) || offset < 0) {
      return { ok: false, status: 400, error: "offset must be a non-negative integer" };
    }
  }

  return { ok: true, query: { q, status, slotId, fromMs, toMs, limit, offset } };
}

function matchesQuery(record: BookingIntentRecord, query: ParsedSearchQuery): boolean {
  if (query.status && record.status !== query.status) return false;
  if (query.slotId && record.slotId !== query.slotId) return false;
  if (query.fromMs !== undefined && record.endTime < query.fromMs) return false;
  if (query.toMs !== undefined && record.startTime > query.toMs) return false;
  if (query.q) {
    const needle = query.q.toLowerCase();
    const haystack = [record.id, record.slotId, record.professional, record.note ?? ""]
      .join("\n")
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export function createBookingsRouter(options: BookingsRouterOptions = {}): Router {
  const router = Router();
  const repository = options.repository ?? new InMemoryBookingIntentRepository();
  const searchRateLimiter =
    options.rateLimiter ??
    createTenantLeakyBucketRateLimiter({ routeScope: "bookings:search" });

  router.get(
    "/search",
    requireAuthenticatedActor(["customer", "professional", "admin", "support"]),
    searchRateLimiter,
    async (req: Request, res: Response): Promise<void> => {
      try {
        const parsed = parseSearchQuery(req);
        if (!parsed.ok) {
          res.status(parsed.status).json({ success: false, error: parsed.error });
          return;
        }

        // Tenant data isolation: callers only ever see their own bookings.
         
        const callerId = String((req as any).auth?.userId ?? "");
        const records = await repository.listByCustomer(callerId);

        const matched = records.filter((record) => matchesQuery(record, parsed.query));
        const results = matched.slice(parsed.query.offset, parsed.query.offset + parsed.query.limit);

        res.status(200).json({
          success: true,
          data: {
            results,
            total: matched.length,
            limit: parsed.query.limit,
            offset: parsed.query.offset,
          },
        });
      } catch (err) {
        logger.error({ err }, "bookings search failed");
        res.status(500).json({ success: false, error: "Search failed" });
      }
    },
  );

  return router;
}

const bookingsRouter = createBookingsRouter();
export default bookingsRouter;
