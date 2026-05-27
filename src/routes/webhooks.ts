import { Router, Request, Response } from "express";

const router = Router();

const VALID_EVENT_TYPES = ["settlement_completed", "settlement_initiated", "settlement_failed"];

router.post("/settlements", (req: Request, res: Response) => {
  const { eventType, transactionId, amount, timestamp } = req.body ?? {};

  if (!eventType) return res.status(400).json({ success: false, error: "Missing required field: eventType" });
  if (!transactionId) return res.status(400).json({ success: false, error: "Missing required field: transactionId" });
  if (amount === undefined || amount === null) return res.status(400).json({ success: false, error: "Missing required field: amount" });
  if (timestamp === undefined || timestamp === null) return res.status(400).json({ success: false, error: "Missing required field: timestamp" });

  if (!VALID_EVENT_TYPES.includes(eventType)) {
    return res.status(400).json({ success: false, error: `Invalid eventType: must be one of ${VALID_EVENT_TYPES.join(", ")}` });
  }
  if (typeof amount !== "number" || amount <= 0) {
    return res.status(400).json({ success: false, error: "Invalid amount: must be a positive number" });
  }
  if (typeof timestamp !== "number" || timestamp <= 0) {
    return res.status(400).json({ success: false, error: "Invalid timestamp: must be a positive number" });
  }

  return res.status(200).json({ success: true, received: req.body });
});

export default router;
