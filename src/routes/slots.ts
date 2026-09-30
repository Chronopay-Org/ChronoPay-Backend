// @ts-nocheck
import { Router, Request, Response } from "express";
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
import { ConflictPreviewBodySchema, CreateSlotBodySchema } from "../middleware/schemas.js";
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

      const ownerId = (slot as any)?.ownerId ?? (slot as any)?.buyerId ?? (slot as any)?.professional ?? actorId;

      if (req.auth?.role !== "admin" && ownerId !== actorId) {
        return res.status(403).json({
          success: false,
          error: "Only the current slot owner may create a secondary listing.",
        });
      }

      if ((slot as any)?.transferable === false) {
        return res.status(422).json({
          success: false,
          error: "This slot is not eligible for resale because the supplier disallowed secondary listing.",
        });
      }

      const body = req.body as Partial<SecondaryListingInput>;
      const priceFloorCents = Number(body.priceFloorCents);
      const expiresAt = Number(body.expiresAt);
      const supplierConsent = body.supplierConsent === true;

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
 */
router.patch("/:id", requireRole(["admin"]), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updatedSlot = slotService.updateSlot(id, req.body);

    res.json({
      success: true,
      slot: updatedSlot,
      meta: {
        invalidatedKeys: ["slots:list:all"],
      },
    });
  } catch (error: any) {
    if (error instanceof SlotNotFoundError) {
      res.status(404).json({ success: false, error: error.message });
    } else if (error instanceof SlotValidationError) {
      res.status(422).json({ success: false, error: error.message });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

/**
 * DELETE /api/v1/slots/:id
 */
router.delete("/:id", authorizeSlotDelete, async (req: Request, res: Response) => {
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
});

export { router };
export default router;
