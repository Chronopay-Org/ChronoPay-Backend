import { Router, Request, Response, NextFunction } from "express";
import { slotService, SlotNotFoundError, SlotValidationError } from "../services/slotService.js";
import { ConflictPreviewService } from "../services/conflictPreviewService.js";
import { RecurrenceError } from "../services/recurrenceService.js";
import { requireApiKey } from "../middleware/apiKeyAuth.js";
import { requireFeatureFlag, featureFlagContextMiddleware } from "../middleware/featureFlags.js";
import { requireRole } from "../middleware/rbac.js";
import { parseSlotIdParam } from "../middleware/slotIdParam.js";
import { authorizeSlotDelete, assertSlotDeleteAllowed } from "../middleware/slotAuthorization.js";
import { resolveBuyerTimezone } from "../middleware/timezone.js";
import { normalizeSlots, normalizeSlotTimes } from "../services/timezoneService.js";
import {
  ConflictPreviewBodySchema,
  CreateSlotBodySchema,
  UpdateSlotBodySchema,
} from "../middleware/schemas.js";
import { validateBody } from "../middleware/validation.js";
import { isValidIANATimezone } from "../validation/reminderValidation.js";
import { requireAuthenticatedActor } from "../middleware/auth.js";
import { createAuthAwareRateLimiter } from "../middleware/rateLimiter.js";
import {
  createSecondaryListing,
  getSlotRecordById,
  type SecondaryListingInput,
} from "../repositories/slotRepository.js";

const router = Router();
const SLOT_NOT_FOUND = "Slot not found";

/**
 * @openapi
 * components:
 *   securitySchemes:
 *     bearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 *       description: JWT token for user authentication.
 *     apiKeyAuth:
 *       type: apiKey
 *       in: header
 *       name: x-api-key
 *       description: API key for service-to-service authentication.
 *     adminTokenAuth:
 *       type: apiKey
 *       in: header
 *       name: x-chronopay-admin-token
 *       description: Admin token for administrative operations.
 *   schemas:
 *     Slot:
 *       type: object
 *       description: A bookable time slot returned by the slots API.
 *       required:
 *         - id
 *         - professional
 *         - startTime
 *         - endTime
 *       properties:
 *         id:
 *           description: >
 *             Slot identifier. Canonical ids are `slot-<uuid>` strings; legacy
 *             numeric ids are also accepted.
 *           oneOf:
 *             - type: string
 *               example: slot-11111111-1111-4111-8111-111111111111
 *             - type: integer
 *               example: 1
 *         professional:
 *           type: string
 *           description: Identifier of the professional offering the slot.
 *           example: alice
 *         startTime:
 *           type: integer
 *           format: int64
 *           description: Start of the slot as Unix epoch milliseconds (UTC).
 *           example: 1704067200000
 *         endTime:
 *           type: integer
 *           format: int64
 *           description: End of the slot as Unix epoch milliseconds (UTC).
 *           example: 1704070800000
 *         createdAt:
 *           type: string
 *           format: date-time
 *           description: When the slot was created.
 *           example: "2024-01-01T00:00:00.000Z"
 *         startTimeLocal:
 *           type: string
 *           nullable: true
 *           description: >
 *             Start time rendered in the buyer's resolved timezone. Present on
 *             list and get responses.
 *           example: "2024-01-01T00:00:00+00:00"
 *         endTimeLocal:
 *           type: string
 *           nullable: true
 *           description: >
 *             End time rendered in the buyer's resolved timezone. Present on
 *             list and get responses.
 *           example: "2024-01-01T01:00:00+00:00"
 *         timezone:
 *           type: string
 *           description: IANA timezone used to render the local times.
 *           example: UTC
 *     ErrorEnvelope:
 *       type: object
 *       description: Canonical error envelope returned when a request fails.
 *       required:
 *         - success
 *         - error
 *       properties:
 *         success:
 *           type: boolean
 *           example: false
 *         error:
 *           type: string
 *           description: Human-readable error message.
 *           example: Slot not found
 *         code:
 *           type: string
 *           description: Machine-readable error code.
 *           example: BAD_REQUEST
 *         requestId:
 *           type: string
 *           description: Request identifier when available.
 *         timestamp:
 *           type: string
 *           format: date-time
 *           description: Time the error was produced.
 */

router.use(featureFlagContextMiddleware);

/**
 * Reset slot store for tests
 */
export function resetSlotStore(): void {
  slotService.reset();
}

/** Longest bookable slot window the platform accepts. */
const MAX_SLOT_DURATION_MS = 24 * 60 * 60 * 1000;

/** True for a usable epoch-ms value (finite number, not NaN). */
function isEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Normalizes an accepted time value to epoch milliseconds.
 *
 * The request schema admits a finite number or a parseable ISO-8601 string;
 * SlotService's range checks are all in epoch ms, so strings are converted
 * here. Values that are neither are passed through untouched so SlotService
 * can reject them with its own validation message.
 */
function toEpochMs(value: unknown): unknown {
  if (typeof value === "string") {
    return Date.parse(value);
  }
  return value;
}

/**
 * GET /api/v1/slots
 *
 * @openapi
 * /api/v1/slots:
 *   get:
 *     tags: [Slots]
 *     summary: List slots
 *     description: >
 *       Returns a paginated list of slots normalized to the buyer's resolved
 *       timezone. Timezone resolution uses the buyer profile (when present),
 *       then the `x-timezone` header, then UTC. The `X-Cache` response header
 *       reports whether the page was served from cache.
 *     security: []
 *     parameters:
 *       - in: query
 *         name: page
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: 1-based page number.
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 10
 *         description: Results per page.
 *       - in: header
 *         name: x-timezone
 *         required: false
 *         schema:
 *           type: string
 *         description: IANA timezone used to render slot times. Invalid values return 400.
 *     responses:
 *       200:
 *         description: Slots retrieved successfully
 *         headers:
 *           X-Cache:
 *             description: Cache status for this response.
 *             schema:
 *               type: string
 *               enum: [HIT, MISS]
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data, slots, page, limit, total, timezone, timezoneSource]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Slot'
 *                 slots:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Slot'
 *                 page:
 *                   type: integer
 *                   example: 1
 *                 limit:
 *                   type: integer
 *                   example: 10
 *                 total:
 *                   type: integer
 *                   example: 125
 *                 timezone:
 *                   type: string
 *                   example: UTC
 *                 timezoneSource:
 *                   type: string
 *                   enum: [profile, header, default]
 *                   example: default
 *                 meta:
 *                   type: object
 *                   properties:
 *                     cache:
 *                       type: string
 *                       example: miss
 *             example:
 *               success: true
 *               data:
 *                 - id: slot-11111111-1111-4111-8111-111111111111
 *                   professional: alice
 *                   startTime: 1704067200000
 *                   endTime: 1704070800000
 *                   createdAt: "2024-01-01T00:00:00.000Z"
 *                   startTimeLocal: "2024-01-01T00:00:00+00:00"
 *                   endTimeLocal: "2024-01-01T01:00:00+00:00"
 *                   timezone: UTC
 *               slots:
 *                 - id: slot-11111111-1111-4111-8111-111111111111
 *                   professional: alice
 *                   startTime: 1704067200000
 *                   endTime: 1704070800000
 *                   createdAt: "2024-01-01T00:00:00.000Z"
 *                   startTimeLocal: "2024-01-01T00:00:00+00:00"
 *                   endTimeLocal: "2024-01-01T01:00:00+00:00"
 *                   timezone: UTC
 *               page: 1
 *               limit: 10
 *               total: 125
 *               timezone: UTC
 *               timezoneSource: default
 *               meta:
 *                 cache: miss
 *       400:
 *         description: Invalid pagination parameters or timezone header
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 */
router.get(
  "/",
  resolveBuyerTimezone(),
  async (req: Request, res: Response) => {
    try {
      const pageStr = req.query.page as string;
      const limitStr = req.query.limit as string;

      const page = pageStr !== undefined ? parseInt(pageStr) : 1;
      const limit = limitStr !== undefined ? parseInt(limitStr) : 10;

      const result = await slotService.list({ page, limit });
      const timezone = req.buyerTimezone || "UTC";
      const normalized = normalizeSlots(result.slots as any, timezone);

      res.set("X-Cache", "MISS");
      res.json({
        success: true,
        data: normalized,
        slots: normalized,
        page: result.page,
        limit: result.limit,
        total: result.total,
        timezone,
        timezoneSource: req.buyerTimezoneSource || "default",
        meta: {
          cache: "miss",
        },
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        error: error.message,
      });
    }
  },
);

/**
 * GET /api/v1/slots/:id
 *
 * @openapi
 * /api/v1/slots/{id}:
 *   get:
 *     tags: [Slots]
 *     summary: Get a slot by ID
 *     description: >
 *       Returns a single slot normalized to the buyer's resolved timezone.
 *       The `X-Cache` response header reports whether the slot came from cache.
 *     security: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: >
 *           Slot id. Either a canonical `slot-<uuid>` identifier or a positive
 *           integer legacy id.
 *       - in: header
 *         name: x-timezone
 *         required: false
 *         schema:
 *           type: string
 *         description: IANA timezone used to render slot times. Invalid values return 400.
 *     responses:
 *       200:
 *         description: Slot retrieved successfully
 *         headers:
 *           X-Cache:
 *             description: Cache status for this response.
 *             schema:
 *               type: string
 *               enum: [HIT, MISS]
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [slot, timezone, timezoneSource]
 *               properties:
 *                 slot:
 *                   $ref: '#/components/schemas/Slot'
 *                 timezone:
 *                   type: string
 *                   example: UTC
 *                 timezoneSource:
 *                   type: string
 *                   enum: [profile, header, default]
 *                   example: default
 *             example:
 *               slot:
 *                 id: slot-11111111-1111-4111-8111-111111111111
 *                 professional: alice
 *                 startTime: 1704067200000
 *                 endTime: 1704070800000
 *                 createdAt: "2024-01-01T00:00:00.000Z"
 *                 startTimeLocal: "2024-01-01T00:00:00+00:00"
 *                 endTimeLocal: "2024-01-01T01:00:00+00:00"
 *                 timezone: UTC
 *               timezone: UTC
 *               timezoneSource: default
 *       400:
 *         description: Invalid slot id or timezone header
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       404:
 *         description: Slot not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 */
router.get("/:id", parseSlotIdParam, resolveBuyerTimezone(), async (req: Request, res: Response) => {
  try {
    const slot = await slotService.findById(req.params.id);
    const timezone = req.buyerTimezone || "UTC";
    const normalized = normalizeSlotTimes(slot as any, timezone);

    res.set("X-Cache", "MISS");
    res.json({
      slot: normalized,
      timezone,
      timezoneSource: req.buyerTimezoneSource || "default",
    });
  } catch (error) {
    if (error instanceof SlotNotFoundError) {
      res.status(404).json({ success: false, error: SLOT_NOT_FOUND });
      return;
    }
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * GET /api/v1/slots/:id/reservations
 *
 * Returns active holds (status='held', expires_at > now) for a slot.
 * Only the slot owner (professional) or an admin may call this endpoint.
 *
 * Query parameters:
 *   page  - page number, 1-based (default 1)
 *   limit - results per page, 1-100 (default 10)
 *
 * @openapi
 * /api/v1/slots/{id}/reservations:
 *   get:
 *     tags: [Slots]
 *     summary: List active reservations for a slot
 *     description: >
 *       Returns active holds (`status: held`, `expiresAt` in the future) for a
 *       slot. Only the slot's professional or an admin may read reservations.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Slot id (canonical `slot-<uuid>` or positive integer).
 *       - in: query
 *         name: page
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: 1-based page number.
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 10
 *         description: Results per page.
 *     responses:
 *       200:
 *         description: Active reservations retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data, page, limit, total]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required: [id, slotId, buyerId, status, expiresAt, createdAt]
 *                     properties:
 *                       id:
 *                         type: string
 *                         example: "1"
 *                       slotId:
 *                         type: string
 *                         example: slot-11111111-1111-4111-8111-111111111111
 *                       buyerId:
 *                         type: string
 *                         nullable: true
 *                         description: Buyer id; null when the caller is not the slot owner.
 *                         example: buyer-1
 *                       status:
 *                         type: string
 *                         enum: [held]
 *                         example: held
 *                       expiresAt:
 *                         type: integer
 *                         format: int64
 *                         description: Unix epoch milliseconds when the hold expires.
 *                         example: 1704074400000
 *                       createdAt:
 *                         type: integer
 *                         format: int64
 *                         description: Unix epoch milliseconds when the hold was created.
 *                         example: 1704067200000
 *                 page:
 *                   type: integer
 *                   example: 1
 *                 limit:
 *                   type: integer
 *                   example: 10
 *                 total:
 *                   type: integer
 *                   example: 1
 *             example:
 *               success: true
 *               data:
 *                 - id: "1"
 *                   slotId: slot-11111111-1111-4111-8111-111111111111
 *                   buyerId: buyer-1
 *                   status: held
 *                   expiresAt: 1704074400000
 *                   createdAt: 1704067200000
 *               page: 1
 *               limit: 10
 *               total: 1
 *       400:
 *         description: Invalid slot id or pagination parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       401:
 *         description: Missing, invalid, or expired bearer token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       403:
 *         description: Caller is not the slot owner and is not an admin
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       404:
 *         description: Slot not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       429:
 *         description: Rate limit exceeded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 */
router.get(
  "/:id/reservations",
  parseSlotIdParam,
  requireAuthenticatedActor(["professional", "admin"]),
  createAuthAwareRateLimiter(),
  async (req: Request, res: Response) => {
    try {
      const slotId = req.params.id;

      // Load slot to verify ownership
      let slot;
      try {
        slot = await slotService.findById(slotId);
      } catch (error) {
        if (error instanceof SlotNotFoundError) {
          return res.status(404).json({ success: false, error: SLOT_NOT_FOUND });
        }
        throw error;
      }

      // Only the slot's professional or an admin may read its reservations
      const isAdmin = req.auth!.role === "admin";
      const isOwner = slot.professional === req.auth!.userId;
      if (!isAdmin && !isOwner) {
        return res.status(403).json({ success: false, error: "Insufficient permissions" });
      }

      // Parse and validate pagination params
      const pageStr = req.query.page as string | undefined;
      const limitStr = req.query.limit as string | undefined;

      const page = pageStr !== undefined ? parseInt(pageStr, 10) : 1;
      const limit = limitStr !== undefined ? parseInt(limitStr, 10) : 10;

      if (!Number.isInteger(page) || page < 1) {
        return res.status(400).json({ success: false, error: "page must be a positive integer" });
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return res.status(400).json({ success: false, error: "limit must be between 1 and 100" });
      }

      const result = slotService.listReservations(String(slotId), true, { page, limit });

      return res.json({
        success: true,
        data: result.data,
        page: result.page,
        limit: result.limit,
        total: result.total,
      });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  },
);

/**
 * POST /api/v1/slots/:id/listings
 *
 * Create a secondary marketplace listing for a slot that has already been
 * transferred to a buyer. The listing is only valid when the current actor is
 * the current owner and the supplier previously granted resale consent.
 *
 * @openapi
 * /api/v1/slots/{id}/listings:
 *   post:
 *     tags: [Slots]
 *     summary: Create a secondary marketplace listing
 *     description: >
 *       Creates a resale listing for a slot the caller currently owns. Supplier
 *       consent and transferability are read from the slot; callers must not
 *       send `supplierConsent` in the request body.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Slot id (canonical `slot-<uuid>` or positive integer).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [priceFloorCents, expiresAt]
 *             properties:
 *               priceFloorCents:
 *                 type: integer
 *                 minimum: 1
 *                 description: Minimum resale price in cents.
 *                 example: 1000
 *               expiresAt:
 *                 type: integer
 *                 format: int64
 *                 description: Future Unix epoch milliseconds when the listing expires.
 *                 example: 1767225600000
 *             description: >
 *               `supplierConsent` must not be provided; it is derived from the
 *               slot record.
 *           example:
 *             priceFloorCents: 1000
 *             expiresAt: 1767225600000
 *     responses:
 *       201:
 *         description: Secondary listing created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, listing]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 listing:
 *                   type: object
 *                   required: [id, slotId, ownerId, priceFloorCents, expiresAt, supplierConsent, state, createdAt, updatedAt]
 *                   properties:
 *                     id:
 *                       type: string
 *                       example: listing-1767225600000-abc1234
 *                     slotId:
 *                       type: string
 *                       example: slot-11111111-1111-4111-8111-111111111111
 *                     ownerId:
 *                       type: string
 *                       example: buyer-1
 *                     priceFloorCents:
 *                       type: integer
 *                       example: 1000
 *                     expiresAt:
 *                       type: integer
 *                       format: int64
 *                       example: 1767225600000
 *                     supplierConsent:
 *                       type: boolean
 *                       example: true
 *                     state:
 *                       type: string
 *                       enum: [active, expired, cancelled, sold]
 *                       example: active
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                       example: "2026-01-01T00:00:00.000Z"
 *                     updatedAt:
 *                       type: string
 *                       format: date-time
 *                       example: "2026-01-01T00:00:00.000Z"
 *             example:
 *               success: true
 *               listing:
 *                 id: listing-1767225600000-abc1234
 *                 slotId: slot-11111111-1111-4111-8111-111111111111
 *                 ownerId: buyer-1
 *                 priceFloorCents: 1000
 *                 expiresAt: 1767225600000
 *                 supplierConsent: true
 *                 state: active
 *                 createdAt: "2026-01-01T00:00:00.000Z"
 *                 updatedAt: "2026-01-01T00:00:00.000Z"
 *       400:
 *         description: >
 *           Invalid request body, non-positive priceFloorCents, non-future
 *           expiresAt, or caller-provided supplierConsent.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       403:
 *         description: Caller is not the current slot owner, or the slot has no transferable owner
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       404:
 *         description: Slot not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       409:
 *         description: A listing already exists for this slot
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       422:
 *         description: Slot is not eligible for resale or supplier consent is missing
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 */
router.post(
  "/:id/listings",
  parseSlotIdParam,
  requireAuthenticatedActor(["customer", "admin"]),
  async (req: Request, res: Response) => {
    try {
      const slotId = req.params.id;
      const actorId = req.auth?.userId;

      if (!actorId) {
        return res.status(401).json({ success: false, error: "Authentication required." });
      }

      let slot: any;
      try {
        slot = await slotService.findById(slotId);
      } catch (error) {
        if (error instanceof SlotNotFoundError) {
          slot = getSlotRecordById(slotId);
          if (!slot) {
            return res.status(404).json({ success: false, error: SLOT_NOT_FOUND });
          }
        } else {
          throw error;
        }
      }

      const ownerId = [(slot as any)?.ownerId, (slot as any)?.buyerId].find(
        (value) => typeof value === "string" && value.trim().length > 0,
      );

      if (typeof ownerId !== "string" || ownerId.trim().length === 0) {
        return res.status(403).json({
          success: false,
          error: "This slot has no transferable owner.",
        });
      }

      if (req.auth?.role !== "admin" && ownerId !== actorId) {
        return res.status(403).json({
          success: false,
          error: "Only the current slot owner may create a secondary listing.",
        });
      }

      const body = (req.body ?? {}) as Partial<SecondaryListingInput>;
      if (Object.prototype.hasOwnProperty.call(body, "supplierConsent")) {
        return res.status(400).json({
          success: false,
          error: "supplierConsent must not be provided; supplier consent is determined from the slot.",
        });
      }

      if ((slot as any)?.transferable === false) {
        return res.status(422).json({
          success: false,
          error: "This slot is not eligible for resale because the supplier disallowed secondary listing.",
        });
      }

      const priceFloorCents = Number(body.priceFloorCents);
      const expiresAt = Number(body.expiresAt);
      const supplierConsent = (slot as any)?.resaleConsent === true || (slot as any)?.transferable === true;

      if (!Number.isInteger(priceFloorCents) || priceFloorCents <= 0) {
        return res.status(400).json({
          success: false,
          error: "priceFloorCents must be a positive integer",
        });
      }
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        return res.status(400).json({
          success: false,
          error: "expiresAt must be a future unix timestamp in ms",
        });
      }
      if (!supplierConsent) {
        return res.status(422).json({
          success: false,
          error: "Supplier consent is required before a slot can be listed for resale.",
        });
      }

      const listing = await createSecondaryListing(slotId, {
        priceFloorCents,
        expiresAt,
        supplierConsent,
      }, actorId);

      return res.status(201).json({
        success: true,
        listing,
      });
    } catch (error: any) {
      if (error instanceof SlotNotFoundError) {
        return res.status(404).json({ success: false, error: SLOT_NOT_FOUND });
      }
      if (typeof error?.message === "string" && error.message.includes("already exists")) {
        return res.status(409).json({
          success: false,
          error: error.message,
        });
      }
      return res.status(400).json({
        success: false,
        error: error?.message || "Unable to create listing",
      });
    }
  },
);

/**
 * POST /api/v1/slots
 *
 * @openapi
 * /api/v1/slots:
 *   post:
 *     tags: [Slots]
 *     summary: Create a slot
 *     description: >
 *       Creates a new bookable slot. Times accept either Unix epoch
 *       milliseconds or ISO-8601 strings. The range must be positive, at most
 *       24 hours long, and `endTime` must be greater than `startTime`. Requires
 *       a valid API key and the `CREATE_SLOT` feature flag.
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [professional, startTime, endTime]
 *             properties:
 *               professional:
 *                 type: string
 *                 minLength: 1
 *                 description: Professional identifier.
 *                 example: alice
 *               startTime:
 *                 description: Start time as Unix epoch milliseconds or an ISO-8601 string.
 *                 oneOf:
 *                   - type: integer
 *                     format: int64
 *                     example: 1704067200000
 *                   - type: string
 *                     format: date-time
 *                     example: "2024-01-01T00:00:00.000Z"
 *               endTime:
 *                 description: End time as Unix epoch milliseconds or an ISO-8601 string.
 *                 oneOf:
 *                   - type: integer
 *                     format: int64
 *                     example: 1704070800000
 *                   - type: string
 *                     format: date-time
 *                     example: "2024-01-01T01:00:00.000Z"
 *           example:
 *             professional: alice
 *             startTime: 1704067200000
 *             endTime: 1704070800000
 *     responses:
 *       201:
 *         description: Slot created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, slot]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 slot:
 *                   $ref: '#/components/schemas/Slot'
 *                 meta:
 *                   type: object
 *                   properties:
 *                     invalidatedKeys:
 *                       type: array
 *                       items:
 *                         type: string
 *             example:
 *               success: true
 *               slot:
 *                 id: 1
 *                 professional: alice
 *                 startTime: 1704067200000
 *                 endTime: 1704070800000
 *               meta:
 *                 invalidatedKeys: [slots:list:all]
 *       400:
 *         description: >
 *           Malformed request body or `endTime` is not greater than `startTime`.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       401:
 *         description: Missing API key
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       403:
 *         description: Invalid API key or endpoint not allowed for the partner tier
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       422:
 *         description: >
 *           A time value is malformed, the duration exceeds 24 hours, or the
 *           slot fails service-side validation.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       503:
 *         description: The CREATE_SLOT feature flag is disabled
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 */
router.post(
  "/",
  requireApiKey(process.env.CHRONOPAY_API_KEY),
  requireFeatureFlag("CREATE_SLOT"),
  // Times that parse but are impossible (negative epoch, > 24h span) are
  // semantically unprocessable rather than malformed, so they answer 422.
  validateBody(CreateSlotBodySchema, 422),
  async (req: Request, res: Response) => {
    try {
      // The schema accepts either an epoch-ms number or an ISO-8601 string;
      // SlotService works in epoch ms, so normalize before handing off.
      const startTime = toEpochMs(req.body.startTime);
      const endTime = toEpochMs(req.body.endTime);

      // Self-contradictory range: 400, the client sent an end at or before the
      // start and no amount of retrying will make that request valid.
      if (isEpoch(startTime) && isEpoch(endTime) && endTime <= startTime) {
        return res.status(400).json({
          success: false,
          error: "endTime must be greater than startTime",
        });
      }

      // Individually valid times that cannot describe a real booking window:
      // 422, the request parses but is semantically unprocessable.
      if (
        isEpoch(startTime) &&
        isEpoch(endTime) &&
        endTime - startTime > MAX_SLOT_DURATION_MS
      ) {
        return res.status(422).json({
          success: false,
          error: "Slot duration cannot exceed 24 hours",
        });
      }

      const slot = slotService.createSlot({
        ...req.body,
        startTime,
        endTime,
      });
      res.status(201).json({
        success: true,
        slot,
        meta: {
          invalidatedKeys: ["slots:list:all"],
        },
      });
    } catch (error: any) {
      const status = error.name === "SlotValidationError" ? 422 : 500;
      res.status(status).json({
        success: false,
        error: error.message,
      });
    }
  },
);

/**
 * POST /api/v1/slots/conflicts/preview
 *
 * Pre-save conflict detection for RRULE series. Returns all collisions
 * with existing slots for the same professional within the materialization
 * horizon, categorized by reason (overlap, blackout, tz-ambiguity).
 *
 * @openapi
 * /api/v1/slots/conflicts/preview:
 *   post:
 *     tags: [Slots]
 *     summary: Preview conflicts for a recurring slot series
 *     description: >
 *       Expands an RRULE series and reports collisions with existing slots for
 *       the same professional within the materialization horizon. The response
 *       categorizes each collision as `overlap`, `blackout`, or `tz-ambiguity`
 *       and suggests the next safe start where possible. Requires a valid API
 *       key and the `CREATE_SLOT` feature flag.
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rrule, professional, slotDurationMs]
 *             properties:
 *               rrule:
 *                 type: string
 *                 minLength: 1
 *                 description: >
 *                   RRULE string with a bounded recurrence (COUNT or UNTIL).
 *                 example: "DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=3"
 *               professional:
 *                 type: string
 *                 minLength: 1
 *                 description: Professional identifier to check against.
 *                 example: alice
 *               slotDurationMs:
 *                 type: number
 *                 exclusiveMinimum: 0
 *                 description: Duration of each proposed occurrence in milliseconds.
 *                 example: 3600000
 *               timezone:
 *                 type: string
 *                 minLength: 1
 *                 description: >
 *                   Optional IANA timezone used for DST-ambiguity detection.
 *                 example: America/New_York
 *               horizonDays:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 365
 *                 default: 90
 *                 description: Materialization horizon in days.
 *                 example: 90
 *           example:
 *             rrule: "DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=3"
 *             professional: alice
 *             slotDurationMs: 3600000
 *             timezone: America/New_York
 *             horizonDays: 90
 *     responses:
 *       200:
 *         description: Conflict preview generated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   required: [totalOccurrences, conflictsFound, conflicts, horizonDays, horizonEnd]
 *                   properties:
 *                     totalOccurrences:
 *                       type: integer
 *                       example: 3
 *                     conflictsFound:
 *                       type: integer
 *                       example: 1
 *                     conflicts:
 *                       type: array
 *                       items:
 *                         type: object
 *                         required: [proposedStart, proposedEnd, conflict, reason, detail]
 *                         properties:
 *                           proposedStart:
 *                             type: integer
 *                             format: int64
 *                             example: 1767261600000
 *                           proposedEnd:
 *                             type: integer
 *                             format: int64
 *                             example: 1767265200000
 *                           conflict:
 *                             type: object
 *                             required: [slotId, slotStart, slotEnd]
 *                             properties:
 *                               slotId:
 *                                 type: string
 *                                 example: slot-11111111-1111-4111-8111-111111111111
 *                               slotStart:
 *                                 type: integer
 *                                 format: int64
 *                                 example: 1767263400000
 *                               slotEnd:
 *                                 type: integer
 *                                 format: int64
 *                                 example: 1767267000000
 *                           reason:
 *                             type: string
 *                             enum: [overlap, blackout, tz-ambiguity]
 *                             example: overlap
 *                           detail:
 *                             type: string
 *                             example: Overlaps existing slot slot-11111111-1111-4111-8111-111111111111 [1767263400000, 1767267000000)
 *                           suggestedNextSafeStart:
 *                             type: integer
 *                             format: int64
 *                             example: 1767267000000
 *                     horizonDays:
 *                       type: integer
 *                       example: 90
 *                     horizonEnd:
 *                       type: integer
 *                       format: int64
 *                       example: 1775037600000
 *             example:
 *               success: true
 *               data:
 *                 totalOccurrences: 3
 *                 conflictsFound: 1
 *                 conflicts:
 *                   - proposedStart: 1767261600000
 *                     proposedEnd: 1767265200000
 *                     conflict:
 *                       slotId: slot-11111111-1111-4111-8111-111111111111
 *                       slotStart: 1767263400000
 *                       slotEnd: 1767267000000
 *                     reason: overlap
 *                     detail: Overlaps existing slot slot-11111111-1111-4111-8111-111111111111 [1767263400000, 1767267000000)
 *                     suggestedNextSafeStart: 1767267000000
 *                 horizonDays: 90
 *                 horizonEnd: 1775037600000
 *       400:
 *         description: Request body failed validation
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       401:
 *         description: Missing API key
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       403:
 *         description: Invalid API key or endpoint not allowed for the partner tier
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       422:
 *         description: Invalid RRULE or non-IANA timezone
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       500:
 *         description: Conflict preview failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       503:
 *         description: The CREATE_SLOT feature flag is disabled
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 */
router.post(
  "/conflicts/preview",
  requireApiKey(process.env.CHRONOPAY_API_KEY),
  requireFeatureFlag("CREATE_SLOT"),
  validateBody(ConflictPreviewBodySchema),
  async (req: Request, res: Response) => {
    try {
      const { rrule, professional, slotDurationMs, timezone, horizonDays } = req.body;

      if (timezone && !isValidIANATimezone(timezone)) {
        return res.status(422).json({
          success: false,
          error: "timezone must be a valid IANA timezone identifier",
        });
      }

      const service = new ConflictPreviewService();
      const result = await service.previewConflicts({
        rrule,
        professional,
        slotDurationMs,
        timezone,
        horizonDays,
      });

      res.json({ success: true, data: result });
    } catch (error: any) {
      if (error instanceof RecurrenceError) {
        return res.status(422).json({
          success: false,
          error: error.message,
        });
      }
      res.status(500).json({
        success: false,
        error: "Conflict preview failed",
      });
    }
  },
);

/**
 * PATCH /api/v1/slots/:id
 *
 * @openapi
 * /api/v1/slots/{id}:
 *   patch:
 *     tags: [Slots]
 *     summary: Update a slot
 *     description: >
 *       Updates an existing slot. Requires an authenticated bearer token with
 *       the `admin` role. Any subset of the mutable fields may be provided.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Slot id (canonical `slot-<uuid>` or positive integer).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               professional:
 *                 type: string
 *                 description: New professional identifier.
 *                 example: carol
 *               startTime:
 *                 description: New start time as Unix epoch milliseconds or ISO-8601 string.
 *                 oneOf:
 *                   - type: integer
 *                     format: int64
 *                     example: 1704067200000
 *                   - type: string
 *                     format: date-time
 *                     example: "2024-01-01T00:00:00.000Z"
 *               endTime:
 *                 description: New end time as Unix epoch milliseconds or ISO-8601 string.
 *                 oneOf:
 *                   - type: integer
 *                     format: int64
 *                     example: 1704070800000
 *                   - type: string
 *                     format: date-time
 *                     example: "2024-01-01T01:00:00.000Z"
 *               validUntil:
 *                 type: integer
 *                 format: int64
 *                 description: Unix epoch milliseconds after which the slot is no longer bookable.
 *                 example: 1704153600000
 *           example:
 *             professional: carol
 *             startTime: 1704067200000
 *             endTime: 1704070800000
 *     responses:
 *       200:
 *         description: Slot updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, slot]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 slot:
 *                   $ref: '#/components/schemas/Slot'
 *                 meta:
 *                   type: object
 *                   properties:
 *                     invalidatedKeys:
 *                       type: array
 *                       items:
 *                         type: string
 *             example:
 *               success: true
 *               slot:
 *                 id: 1
 *                 professional: carol
 *                 startTime: 1704067200000
 *                 endTime: 1704070800000
 *               meta:
 *                 invalidatedKeys: [slots:list:all]
 *       400:
 *         description: Malformed request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       401:
 *         description: Missing, invalid, or expired bearer token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       403:
 *         description: Caller is not an admin
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       404:
 *         description: Slot not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       422:
 *         description: Slot validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 */
router.patch(
  "/:id",
  parseSlotIdParam,
  requireRole(["admin"]),
  validateBody(UpdateSlotBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const updatedSlot = slotService.updateSlot(id, {
        ...req.body,
        ...(req.body.startTime !== undefined && { startTime: toEpochMs(req.body.startTime) }),
        ...(req.body.endTime !== undefined && { endTime: toEpochMs(req.body.endTime) }),
      });

      res.json({
        success: true,
        slot: updatedSlot,
        meta: {
          invalidatedKeys: ["slots:list:all"],
        },
      });
    } catch (error) {
      if (error instanceof SlotNotFoundError) {
        res.status(404).json({ success: false, error: error.message });
      } else if (error instanceof SlotValidationError) {
        res.status(422).json({ success: false, error: error.message });
      } else {
        next(error);
      }
    }
  },
);

/**
 * DELETE /api/v1/slots/:id
 *
 * @openapi
 * /api/v1/slots/{id}:
 *   delete:
 *     tags: [Slots]
 *     summary: Delete a slot
 *     description: >
 *       Deletes a slot. The caller must identify via the `x-chronopay-user-id`
 *       and `x-chronopay-role` headers, or the legacy `x-user-id` and `x-role`
 *       headers. Admins may delete any slot; other callers may delete only
 *       their own slots. The legacy header pair hides foreign slots behind a
 *       404 instead of a 403.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Slot id (canonical `slot-<uuid>` or positive integer).
 *       - in: header
 *         name: x-chronopay-user-id
 *         required: false
 *         schema:
 *           type: string
 *         description: Caller identity for the ChronoPay header scheme.
 *       - in: header
 *         name: x-chronopay-role
 *         required: false
 *         schema:
 *           type: string
 *         description: Caller role for the ChronoPay header scheme (`admin` bypasses ownership).
 *       - in: header
 *         name: x-user-id
 *         required: false
 *         schema:
 *           type: string
 *         description: Caller identity for the legacy header scheme.
 *       - in: header
 *         name: x-role
 *         required: false
 *         schema:
 *           type: string
 *         description: Caller role for the legacy header scheme (`admin` bypasses ownership).
 *     responses:
 *       200:
 *         description: Slot deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, deletedSlotId]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 deletedSlotId:
 *                   oneOf:
 *                     - type: string
 *                       example: slot-11111111-1111-4111-8111-111111111111
 *                     - type: integer
 *                       example: 1
 *             example:
 *               success: true
 *               deletedSlotId: 1
 *       400:
 *         description: Invalid slot id
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       403:
 *         description: Insufficient permissions (ChronoPay header scheme)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       404:
 *         description: Slot not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 */
router.delete(
  "/:id",
  parseSlotIdParam,
  authorizeSlotDelete,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      if (req.slotDeleteAuth) {
        const allowed = await assertSlotDeleteAllowed(req, res, id);
        if (!allowed) {
          return;
        }
      }

      const deletedSlotId = await slotService.deleteSlot(id);
      res.json({ success: true, deletedSlotId });
    } catch (error: any) {
      if (error instanceof SlotNotFoundError) {
        res.status(404).json({ success: false, error: SLOT_NOT_FOUND });
      } else {
        res.status(500).json({ success: false, error: error.message });
      }
    }
  },
);

export { router };
export default router;
