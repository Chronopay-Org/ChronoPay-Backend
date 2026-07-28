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

const router = Router();
const SLOT_NOT_FOUND = "Slot not found";

router.use(featureFlagContextMiddleware);

/**
 * Reset slot store for tests
 */
export function resetSlotStore(): void {
  slotService.reset();
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
 * POST /api/v1/slots
 */
router.post(
  "/",
  requireApiKey("test-api-key"),
  requireFeatureFlag("CREATE_SLOT"),
  validateBody(CreateSlotBodySchema),
  async (req: Request, res: Response) => {
    try {
      const slot = slotService.createSlot(req.body);
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
  requireApiKey("test-api-key"),
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
