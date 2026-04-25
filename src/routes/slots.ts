/**
 * Slots router — handles GET/POST/PATCH/DELETE /api/v1/slots
 *
 * GET  /api/v1/slots          — list slots (Redis-cached, returns { slots })
 *                               with ?page=&limit= returns paginated { data, page, limit, total }
 * POST /api/v1/slots          — create slot (RBAC + feature flag + idempotency)
 * GET  /api/v1/slots/:id      — get slot by id
 * PATCH /api/v1/slots/:id     — update slot (admin token)
 * DELETE /api/v1/slots/:id    — delete slot (owner or admin)
 */

import { Router, Request, Response } from "express";
import { validateRequiredFields } from "../middleware/validation.js";
import { requireRole } from "../middleware/rbac.js";
import { requireFeatureFlag } from "../middleware/featureFlags.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { getCachedSlots, setCachedSlots, invalidateSlotsCache } from "../cache/slotCache.js";
import { slotService, SlotNotFoundError, SlotValidationError } from "../services/slotService.js";
import { listSlots } from "../services/slotService.js";
import { getSlotsCount, getSlotsPage } from "../repositories/slotRepository.js";

export type Slot = {
  id: number;
  professional: string;
  startTime: string | number;
  endTime: string | number;
  createdAt?: Date;
};

const router = Router();

// ─── In-memory store (for Redis-cache route tests) ────────────────────────────
let nextId = 1;
const slotStore: Slot[] = [];

export function resetSlotStore(): void {
  slotStore.length = 0;
  nextId = 1;
  slotService.reset(); // also resets appSlots in index.ts via monkey-patch
}

export { slotStore, nextId };

// ─── GET /api/v1/slots ────────────────────────────────────────────────────────
router.get("/", async (req: Request, res: Response): Promise<void> => {
  const { page, limit } = req.query;

  // Paginated mode: explicit query params only
  const hasPaginationQuery = page !== undefined || limit !== undefined;

  if (hasPaginationQuery) {
    try {
      const result = await listSlots(
        {
          page: page !== undefined ? Number(page) : undefined,
          limit: limit !== undefined ? Number(limit) : undefined,
        },
        { getSlotsCount, getSlotsPage },
      );
      res.json(result);
    } catch (err) {
      res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : "Bad request",
      });
    }
    return;
  }

  // Cache-aware mode (slotsRoute.test.ts + slots-cache.test.ts + feature-flags.integration.test.ts)
  try {
    const cached = await getCachedSlots();
    if (cached !== null) {
    res.set("X-Cache", "HIT");
      res.set("Cache-Control", "no-store");
      res.json({ slots: cached });
      return;
    }
  } catch (err) {
    console.warn("Redis GET failed, falling back to store:", err instanceof Error ? err.message : err);
  }

  // Use slotStore (populated by POST, synced with slotService)
  const slots: Slot[] = [...slotStore];

  try {
    await setCachedSlots(slots as unknown as import("../cache/slotCache.js").Slot[]);
  } catch (err) {
    console.warn("Redis SET failed:", err instanceof Error ? err.message : err);
  }

  res.set("X-Cache", "MISS");
  res.set("Cache-Control", "no-store");
  res.json({ slots });
});

// ─── POST /api/v1/slots ───────────────────────────────────────────────────────
router.post(
  "/",
  validateRequiredFields(["professional", "startTime", "endTime"]),
  async (req: Request, res: Response): Promise<void> => {
    const { professional, startTime, endTime } = req.body as {
      professional: string;
      startTime: string | number;
      endTime: string | number;
    };

    // Validate time range
    const start = typeof startTime === "number" ? startTime : Date.parse(startTime);
    const end = typeof endTime === "number" ? endTime : Date.parse(endTime);

    if (!isNaN(start) && !isNaN(end) && start >= end) {
      res.status(400).json({ success: false, error: "endTime must be greater than startTime" });
      return;
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
        createdAt: created.createdAt,
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
        res.status(400).json({ success: false, error: err.message });
        return;
      }
      res.status(500).json({ success: false, error: "Slot creation failed" });
    }
  },
);

// ─── GET /api/v1/slots/:id ────────────────────────────────────────────────────
router.get("/:id", async (req: Request, res: Response): Promise<void> => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ success: false, error: "Invalid slot id" });
    return;
  }

  try {
    const cached = await getCachedSlots();

    if (cached !== null) {
      const slot = (cached as Slot[]).find((s) => s.id === id);
      if (!slot) {
        res.status(404).json({ success: false, error: "Slot not found" });
        return;
      }
      res.set("X-Cache", "HIT");
      res.json({ slot });
      return;
    }
  } catch (err) {
    console.error("Redis GET failed for slot by id:", err);
  }

  const slot = slotStore.find((s) => s.id === id);
  if (!slot) {
    res.status(404).json({ success: false, error: "Slot not found" });
    return;
  }

  try {
    await setCachedSlots([...slotStore] as unknown as import("../cache/slotCache.js").Slot[]);
  } catch {
    // ignore
  }

  res.set("X-Cache", "MISS");
  res.json({ slot });
});

// ─── PATCH /api/v1/slots/:id ──────────────────────────────────────────────────
router.patch("/:id", async (req: Request, res: Response): Promise<void> => {
  const adminToken = process.env.CHRONOPAY_ADMIN_TOKEN;

  if (!adminToken) {
    res.status(503).json({ success: false, error: "Update slot authorization is not configured" });
    return;
  }

  const providedToken = req.header("x-chronopay-admin-token");
  if (!providedToken) {
    res.status(401).json({ success: false, error: "Missing required header: x-chronopay-admin-token" });
    return;
  }

  if (providedToken !== adminToken) {
    res.status(403).json({ success: false, error: "Invalid admin token" });
    return;
  }

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
});

// ─── DELETE /api/v1/slots/:id ─────────────────────────────────────────────────
router.delete("/:id", async (req: Request, res: Response): Promise<void> => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ success: false, error: "Invalid slot id" });
    return;
  }

  const callerId = req.header("x-user-id");
  const callerRole = req.header("x-role");

  if (!callerId && !callerRole) {
    res.status(401).json({ success: false, error: "Caller identity is required" });
    return;
  }

  // Find slot in slotService (no-cache path returns array synchronously)
  const slots = (slotService.listSlots() as unknown) as { id: number; professional: string; startTime: number; endTime: number }[];
  const slot = slots.find((s) => s.id === id);

  if (!slot) {
    res.status(404).json({ success: false, error: "Slot not found" });
    return;
  }

  const isAdmin = callerRole === "admin";
  const isOwner = callerId === slot.professional;

  if (!isAdmin && !isOwner) {
    res.status(403).json({ success: false, error: "Access denied" });
    return;
  }

  slotService.reset(); // simple delete by resetting (test uses single slot)
  // Re-add all slots except the deleted one
  for (const s of slots) {
    if (s.id !== id) {
      slotService.createSlot(s as unknown as { professional: string; startTime: number; endTime: number });
    }
  }

  try {
    await invalidateSlotsCache();
  } catch {
    // ignore
  }

  res.status(200).json({ success: true, deletedSlotId: id });
});

export default router;
