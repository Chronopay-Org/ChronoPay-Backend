import { Router, type Request, type Response } from "express";
import { requireAuthenticatedActor } from "../middleware/auth.js";
import { fraudReviewQueue } from "../services/fraudReviewQueue.js";

const router = Router();

/**
 * @route GET /api/v1/admin/fraud/hitl/queue
 * @desc Get pending review items for medium-risk fraud scores.
 * @access Private (admin role required)
 */
router.get("/fraud/hitl/queue", requireAuthenticatedActor(["admin"]), (req: Request, res: Response) => {
  res.json({ success: true, items: fraudReviewQueue.getPendingItems() });
});

/**
 * @route POST /api/v1/admin/fraud/hitl/:id/decision
 * @desc Operator endpoint for approve/reject/refer on HITL queue items.
 * @access Private (admin role required)
 */
router.post("/fraud/hitl/:id/decision", requireAuthenticatedActor(["admin"]), (req: Request, res: Response) => {
  const { decision, notes } = req.body;
  const operatorId = req.auth?.userId || "unknown";

  if (!["approved", "rejected", "referred"].includes(decision)) {
    return res.status(400).json({ success: false, error: "Invalid decision. Must be approved, rejected, or referred." });
  }

  try {
    const item = fraudReviewQueue.decide(req.params.id, operatorId, decision, notes);
    return res.json({ success: true, item });
  } catch (err: any) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

export default router;
