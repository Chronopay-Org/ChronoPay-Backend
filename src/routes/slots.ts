/**
 * @file src/routes/slots.ts
 *
 * Express router for the /api/v1/slots resource.
 *
 * Cache behaviour
 * ───────────────
 * GET  /api/v1/slots
 *   Checks the Redis cache first.
 *   HIT  → responds immediately; sets `X-Cache: HIT`.
 *   MISS → runs the data-access logic, writes the result to cache with a TTL,
 *          sets `X-Cache: MISS`.
 *   If Redis is unavailable the handler falls through to the data-access path
 *   transparently (graceful degradation).
 *
 * POST /api/v1/slots
 *   Creates a new slot, then invalidates the `slots:all` cache key so that
 *   the next GET reflects the new record.
 */

import { Router, Request, Response } from "express";
import { validateRequiredFields } from "../middleware/validation.js";
import {
  getCachedSlots,
  setCachedSlots,
  invalidateSlotsCache,
  type Slot,
} from "../cache/slotCache.js";

const router = Router();

// ─── In-memory store (replace with DB layer in production) ───────────────────
// This mirrors the stub behaviour of the original app.ts while keeping the
// route file self-contained.  Swap `slotStore` for a real repository call
// without touching the caching logic.

let nextId = 1;
const slotStore: Slot[] = [];

/** Exposed for test teardown — resets the in-process store to a clean state. */
export function resetSlotStore(): void {
  slotStore.length = 0;
  nextId = 1;
}

export function findSlotById(id: number): Slot | undefined {
  return slotStore.find((slot) => slot.id === id);
}

export function removeSlotById(id: number): Slot | undefined {
  const index = slotStore.findIndex((slot) => slot.id === id);
  if (index < 0) {
    return undefined;
  }
  const [removed] = slotStore.splice(index, 1);
  return removed;
}

export function listStoredSlots(): Slot[] {
  return [...slotStore];
}

// ─── Routes ───────────────────────────────────────────────────────────────────

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
  // ── 1. Try cache ────────────────────────────────────────────────────────────
  const cached = await getCachedSlots();
  if (cached !== null) {
    res.set("X-Cache", "HIT");
    res.json({ slots: cached });
    return;
  }

  // ── 2. Cache miss — fetch from data source ──────────────────────────────────
  // TODO: replace with real DB query (e.g. slotRepository.findAll())
  const slots: Slot[] = [...slotStore];

  // ── 3. Populate cache for subsequent requests ───────────────────────────────
  await setCachedSlots(slots);

  res.set("X-Cache", "MISS");
  res.json({ slots });
});

/**
 * @openapi
 * /api/v1/slots:
 *   post:
 *     summary: Create a new slot
 *     description: >
 *       Creates a slot and invalidates the `slots:all` cache so the next GET
 *       reflects the new record. Requires API key authentication for service access.
 *     tags: [Slots]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateSlotInput'
 *     responses:
 *       201:
 *         description: Slot created successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 slot:
 *                   $ref: '#/components/schemas/Slot'
 *       400:
 *         description: Missing required fields.
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *
 * @openapi
 * components:
 *   schemas:
 *     Slot:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         professional:
 *           type: string
 *         startTime:
 *           type: string
 *           format: date-time
 *         endTime:
 *           type: string
 *           format: date-time
 *     CreateSlotInput:
 *       type: object
 *       required: [professional, startTime, endTime]
 *       properties:
 *         professional:
 *           type: string
 *         startTime:
 *           type: string
 *           format: date-time
 *         endTime:
 *           type: string
 *           format: date-time
 */
router.post(
  "/",
  validateRequiredFields(["professional", "startTime", "endTime"]),
  async (req: Request, res: Response): Promise<void> => {
    const { professional, startTime, endTime } = req.body as {
      professional: string;
      startTime: string;
      endTime: string;
    };

    // ── Create the slot ────────────────────────────────────────────────────────
    const newSlot: Slot = {
      id: nextId++,
      professional,
      startTime,
      endTime,
    };
    slotStore.push(newSlot);

    // ── Invalidate cache so the next GET re-fetches fresh data ─────────────────
    await invalidateSlotsCache();

    res.status(201).json({ success: true, slot: newSlot });
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
router.get("/:id", async (req: Request, res: Response): Promise<void> => {
  const idParam = req.params.id;

  // ── Validate ID ───────────────────────────────────────────────
  const id = Number(idParam);

  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({
      success: false,
      error: "Invalid slot id",
    });
    return;
  }

  try {
    // ── 1. Try cache first ───────────────────────────────────────
    const cached = await getCachedSlots();

    if (cached !== null) {
      const slot = cached.find((s) => s.id === id);

      if (!slot) {
        res.status(404).json({
          success: false,
          error: "Slot not found",
        });
        return;
      }

      res.set("X-Cache", "HIT");
      res.json({ slot });
      return;
    }

    // ── 2. Cache miss → fallback to store ───────────────────────
    const slot = slotStore.find((s) => s.id === id);

    if (!slot) {
      res.status(404).json({
        success: false,
        error: "Slot not found",
      });
      return;
    }

    // populate cache for next calls
    await setCachedSlots([...slotStore]);

    res.set("X-Cache", "MISS");
    res.json({ slot });
  } catch (err) {
    // ── Graceful degradation ────────────────────────────────────
    console.error("Get slot by id failed", err);

    const slot = slotStore.find((s) => s.id === id);

    if (!slot) {
      res.status(404).json({
        success: false,
        error: "Slot not found",
      });
      return;
    }

    res.json({ slot });
  }
});

export default router;
