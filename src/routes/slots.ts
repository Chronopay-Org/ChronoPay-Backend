import { Router, Request, Response } from "express";
import { listSlotsCursor, MAX_LIMIT } from "../services/slotService.js";
import { requireAuth } from "../middleware/auth.js";
import { validateRequiredFields } from "../middleware/validation.js";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  const cursorQ = req.query.cursor as string | undefined;
  const limitQ = req.query.limit;
  const sortQ = (req.query.sort as string) || "asc";

  const limit = limitQ === undefined ? 10 : Number(limitQ);

  if (!Number.isInteger(limit) || limit < 1) {
    return res.status(400).json({ success: false, error: "Invalid limit" });
  }

  if (limit > MAX_LIMIT) {
    return res.status(400).json({ success: false, error: `limit must be <= ${MAX_LIMIT}` });
  }

  if (!["asc", "desc"].includes(sortQ)) {
    return res.status(400).json({ success: false, error: "Invalid sort; must be 'asc' or 'desc'" });
  }

  const { data, total, nextCursor } = await listSlotsCursor({ cursor: cursorQ || null, limit, sort: sortQ as "asc" | "desc" });

  res.json({ data, cursor: cursorQ || null, nextCursor, limit, total });
});

router.post(
  "/",
  requireAuth("chronopay"),
  validateRequiredFields(["professional", "startTime", "endTime"]),
  async (req: Request, res: Response) => {
    const { professional, startTime, endTime } = req.body;

    res.status(201).json({ success: true, slot: { id: 1, professional, startTime, endTime }, actor: req.auth });
  },
);

export default router;
