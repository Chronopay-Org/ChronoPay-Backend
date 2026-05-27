/**
 * Slots router — handles GET/POST/PATCH/DELETE /api/v1/slots
 *
 * GET  /api/v1/slots          — list slots (Redis-cached, returns { slots })
 *                               with ?page=&limit= returns paginated { data, page, limit, total }
 * POST /api/v1/slots          — create slot (RBAC + feature flag + idempotency)
 * GET  /api/v1/slots/:id      — get slot by id
 * PATCH /api/v1/slots/:id     — update slot (admin only via requireRole)
 * DELETE /api/v1/slots/:id    — delete slot (owner or admin via requireAuthenticatedActor)
 */

import { Router, Request, Response, NextFunction } from "express";
import { validateRequiredFields } from "../middleware/validation.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import {
  getCachedSlots,
  setCachedSlots,
  invalidateSlotsCache,
  getOrFetchSlots,
  type Slot as CacheSlot,
} from "../cache/slotCache.js";
import {
  slotService,
  SlotValidationError,
  SlotNotFoundError,
} from "../services/slotService.js";
import { requireRole } from "../middleware/rbac.js";
import {
  requireAuthenticatedActor,
  type AuthenticatedRequest,
} from "../middleware/auth.js";

export type Slot = {
  id: number;
  professional: string;
  startTime: string | number;
  endTime: string | number;
  createdAt?: Date;
};

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  const cursorQ = req.query.cursor as string | undefined;
  const limitQ = req.query.limit;
  const sortQ = (req.query.sort as string) || "asc";

export function resetSlotStore(): void {
  slotStore.length = 0;
  nextId = 1;
  slotService.reset();
}

  if (!Number.isInteger(limit) || limit < 1) {
    return res.status(400).json({ success: false, error: "Invalid limit" });
  }

  if (limit > MAX_LIMIT) {
    return res.status(400).json({ success: false, error: `limit must be <= ${MAX_LIMIT}` });
  }

  if (!["asc", "desc"].includes(sortQ)) {
    return res.status(400).json({ success: false, error: "Invalid sort; must be 'asc' or 'desc'" });
  }

/**
 * @openapi
 * /api/v1/slots:
 *   get:
 *     summary: List all available slots
 *     description: >
 *       Returns the full list of slots.  Results are served from the Redis
 *       cache when available (TTL controlled by REDIS_SLOT_TTL_SECONDS env
 *       var, default 60 s).  The `X-Cache` response header indicates whether
 *       the response was a cache HIT or MISS.
 *     tags: [Slots]
 *     security:
 *       - chronoPayAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: A list of slot objects.
 *         headers:
 *           X-Cache:
 *             schema:
 *               type: string
 *               enum: [HIT, MISS]
 *             description: Indicates whether the response came from cache.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 slots:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Slot'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 */
router.get("/", async (_req: Request, res: Response): Promise<void> => {
  const { slots, cacheStatus } = await getOrFetchSlots(async () => [...slotStore] as unknown as CacheSlot[]);

  res.json({ data, cursor: cursorQ || null, nextCursor, limit, total });
});

router.post(
  "/",
  requireAuth("chronopay"),
  validateRequiredFields(["professional", "startTime", "endTime"]),
  idempotencyMiddleware,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { professional, startTime, endTime } = req.body as {
      professional: string;
      startTime: string | number;
      endTime: string | number;
    };

    // Validate time range
    const start = typeof startTime === "number" ? startTime : Date.parse(startTime);
    const end = typeof endTime === "number" ? endTime : Date.parse(endTime);

    if (!isNaN(start) && !isNaN(end) && start >= end) {
      throw new BadRequestError("endTime must be greater than startTime");
    }

    try {
      const created = slotService.createSlot({
        professional,
        startTime: typeof startTime === "number" ? startTime : (isNaN(start) ? 0 : start),
        endTime: typeof endTime === "number" ? endTime : (isNaN(end) ? 0 : end),
      });

      const slot: Slot = {
        id: created.id,
        professional: created.professional,
        startTime,
        endTime,
        createdAt: created.createdAt ? new Date(created.createdAt) : undefined,
      };

      // Also push to slotStore for Redis-cache route compatibility
      slotStore.push(slot);

      const invalidatedKeys: string[] = [];
      try {
        await invalidateSlotsCache();
        invalidatedKeys.push("slots:all");
        invalidatedKeys.push("slots:list:all");
      } catch (err) {
        console.warn("Cache invalidation failed:", err instanceof Error ? err.message : err);
      }

      res.status(201).json({ success: true, slot, meta: { invalidatedKeys } });
    } catch (err) {
      if (err instanceof SlotValidationError) {
        next(new BadRequestError(err.message));
        return;
      }
      next(new InternalServerError("Slot creation failed"));
    }
  },
);

/**
 * @openapi
 * /api/v1/slots/{id}:
 *   get:
 *     summary: Get slot by ID
 *     description: >
 *       Returns a single slot by ID.
 *       Attempts to read from cache first, then falls back to data store.
 *     tags: [Slots]
 *     security:
 *       - chronoPayAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Slot ID
 *     responses:
 *       200:
 *         description: Slot found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 slot:
 *                   $ref: '#/components/schemas/Slot'
 *       400:
 *         description: Invalid ID supplied
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         description: Slot not found
 */
router.get("/:id", async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    next(new BadRequestError("Invalid slot id"));
    return;
  }

  try {
    const cached = await getCachedSlots();

    if (cached !== null) {
      const slot = (cached as CacheSlot[]).find((s) => s.id === id);
      if (!slot) {
        next(new NotFoundError("Slot not found"));
        return;
      }
      res.set("X-Cache", "HIT");
      res.json({ slot });
      return;
    }
  } catch (err) {
    logger.error({ err, requestId: req.requestId ?? req.id }, "Redis GET failed for slot by id");
  }

  const slot = slotStore.find((s) => s.id === id);
  if (!slot) {
    next(new NotFoundError("Slot not found"));
    return;
  }

  try {
    await setCachedSlots([...slotStore] as unknown as CacheSlot[]);
  } catch {
    // ignore
  }

  res.set("X-Cache", "MISS");
  res.json({ slot });
});

// ─── PATCH /api/v1/slots/:id ──────────────────────────────────────────────────
router.patch(
  "/:id",
  requireRole(["admin"]),
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ success: false, error: "slotId must be a positive integer" });
      return;
    }

    const { professional, startTime, endTime } = req.body ?? {};
    if (professional === undefined && startTime === undefined && endTime === undefined) {
      res.status(400).json({ success: false, error: "update payload must include at least one field" });
      return;
    }

    try {
      const updated = slotService.updateSlot(id, { professional, startTime, endTime });
      res.status(200).json({ success: true, slot: updated });
    } catch (err) {
      if (err instanceof SlotNotFoundError) {
        res.status(404).json({ success: false, error: `Slot ${id} was not found` });
        return;
      }
      if (err instanceof SlotValidationError) {
        res.status(400).json({ success: false, error: err.message });
        return;
      }
      res.status(500).json({ success: false, error: "Slot update failed" });
    }
  },
);

// ─── DELETE /api/v1/slots/:id ─────────────────────────────────────────────────

function requireOwnerOrAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ success: false, error: "Invalid slot id" });
    return;
  }

  const slot = slotStore.find((s) => s.id === id);
  if (!slot) {
    res.status(404).json({ success: false, error: "Slot not found" });
    return;
  }

  const { userId, role } = req.auth!;
  if (role !== "admin" && slot.professional !== userId) {
    res.status(403).json({ success: false, error: "Access denied" });
    return;
  }

  next();
}

router.delete(
  "/:id",
  requireAuthenticatedActor(["customer", "admin", "professional"]),
  requireOwnerOrAdmin as unknown as (req: Request, res: Response, next: NextFunction) => void,
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);

    removeSlotById(id);

    const remaining = listStoredSlots();
    slotService.reset();
    for (const s of remaining) {
      try {
        slotService.createSlot({
          professional: s.professional,
          startTime: typeof s.startTime === "number" ? s.startTime : Date.parse(s.startTime as string),
          endTime: typeof s.endTime === "number" ? s.endTime : Date.parse(s.endTime as string),
        });
      } catch {
        // ignore individual slot recreation failures
      }
    }

    try {
      await invalidateSlotsCache();
    } catch {
      // ignore
    }

    res.status(200).json({ success: true, deletedSlotId: id });
  },
);

export default router;
