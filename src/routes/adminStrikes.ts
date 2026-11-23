import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import { strikeService } from "../services/strikeService.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// No-Show Penalty Strike Routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @route POST /api/v1/admin/buyers/:buyerId/strikes
 * @desc Issue a no-show penalty strike against a buyer.
 *   Body: { reason, intentId?, slotId? }
 *   Automatically suspends buyer when threshold is reached.
 * @access Private (admin token only)
 */
router.post("/buyers/:buyerId/strikes", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const { buyerId } = req.params;
    const { reason, intentId, slotId } = req.body ?? {};

    if (!buyerId || typeof buyerId !== "string") {
      return res.status(400).json({ success: false, error: "buyerId is required" });
    }

    const result = await strikeService.issueStrike({
      buyerId,
      intentId,
      slotId,
      reason: reason || "No-show penalty strike",
    });

    return res.status(201).json({
      success: true,
      strike: result.strike,
      autoSuspended: result.autoSuspended,
      suspension: result.buyerSuspension,
    });
  } catch (err: any) {
    return res.status(400).json({ success: false, error: err.message ?? "Failed to issue strike" });
  }
});

/**
 * @route GET /api/v1/admin/buyers/:buyerId/strikes
 * @desc Get all strikes and suspension status for a buyer.
 * @access Private (admin token only)
 */
router.get("/buyers/:buyerId/strikes", requireAdminToken, (req: Request, res: Response) => {
  try {
    const { buyerId } = req.params;
    if (!buyerId) {
      return res.status(400).json({ success: false, error: "buyerId is required" });
    }

    const strikes = strikeService.getBuyerStrikes(buyerId);
    const suspension = strikeService.getBuyerSuspensionStatus(buyerId);

    return res.status(200).json({
      success: true,
      buyerId,
      strikes,
      activeStrikesCount: suspension.activeStrikesCount,
      suspension: {
        isSuspended: suspension.isSuspended,
        suspendedAt: suspension.suspendedAt,
        suspensionReason: suspension.suspensionReason,
      },
    });
  } catch (err: any) {
    return res.status(400).json({ success: false, error: err.message ?? "Failed to retrieve strikes" });
  }
});

/**
 * @route POST /api/v1/admin/buyers/:buyerId/strikes/:strikeId/appeal
 * @desc Appeal a no-show penalty strike within 72 hours (or as configured).
 *   Body: { reason, evidence? }
 *   Evidence is an array of references (URLs or file paths).
 *   The appeal pauses penalty enforcement by changing strike status.
 * @access Private (admin token only)
 */
router.post(
  "/buyers/:buyerId/strikes/:strikeId/appeal",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const { strikeId } = req.params;
      const { reason, evidence } = req.body ?? {};

      if (!reason || typeof reason !== "string" || reason.trim() === "") {
        return res.status(400).json({ success: false, error: "Appeal reason is required" });
      }

      const evidenceArr = Array.isArray(evidence) ? evidence.filter((e: unknown) => typeof e === "string") : undefined;

      const result = await strikeService.appealStrike(strikeId, reason, evidenceArr);

      return res.status(200).json({
        success: true,
        strike: result.strike,
        suspensionLifted: result.suspensionLifted,
        suspension: result.buyerSuspension,
        message: "No-show penalty appeal filed. Penalty enforcement is paused pending review.",
      });
    } catch (err: any) {
      const status = err.message?.includes("not found") ? 404 : 400;
      return res.status(status).json({ success: false, error: err.message ?? "Appeal failed" });
    }
  },
);

/**
 * @route POST /api/v1/admin/buyers/:buyerId/reinstate
 * @desc Reinstate a suspended buyer and optionally clear active strikes.
 *   Body: { reason, clearActiveStrikes? }
 * @access Private (admin token only)
 */
router.post(
  "/buyers/:buyerId/reinstate",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const { buyerId } = req.params;
      const { reason, clearActiveStrikes } = req.body ?? {};
      const adminId = req.auth?.userId ?? req.header("x-chronopay-admin-token") ?? "admin";

      const result = await strikeService.reinstateBuyer(
        buyerId,
        {
          adminId,
          reason: reason || "Admin reinstatement",
          clearActiveStrikes: clearActiveStrikes !== false,
        },
      );

      return res.status(200).json({
        success: true,
        suspension: result.buyerSuspension,
        rescindedStrikesCount: result.rescindedStrikesCount,
      });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message ?? "Reinstatement failed" });
    }
  },
);

/**
 * @route GET /api/v1/admin/strikes/config
 * @desc Get the current strike system configuration.
 * @access Private (admin token only)
 */
router.get("/strikes/config", requireAdminToken, (_req: Request, res: Response) => {
  return res.status(200).json({
    success: true,
    config: strikeService.getConfig(),
  });
});

/**
 * @route PUT /api/v1/admin/strikes/config
 * @desc Update strike system configuration.
 *   Body: { maxStrikesThreshold?, decayWindowMs?, autoSuspendEnabled? }
 * @access Private (admin token only)
 */
router.put("/strikes/config", requireAdminToken, (req: Request, res: Response) => {
  try {
    const { maxStrikesThreshold, decayWindowMs, autoSuspendEnabled } = req.body ?? {};
    const updates: Record<string, unknown> = {};

    if (maxStrikesThreshold !== undefined) updates.maxStrikesThreshold = maxStrikesThreshold;
    if (decayWindowMs !== undefined) updates.decayWindowMs = decayWindowMs;
    if (autoSuspendEnabled !== undefined) updates.autoSuspendEnabled = autoSuspendEnabled;

    const config = strikeService.updateConfig(updates as Parameters<typeof strikeService.updateConfig>[0]);
    return res.status(200).json({ success: true, config });
  } catch (err: any) {
    return res.status(400).json({ success: false, error: err.message ?? "Failed to update config" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// No-Show Appeal Arbitration Queue Routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @route POST /api/v1/admin/strikes/:strikeId/escalate
 * @desc Escalate an appealed no-show penalty strike to the arbitration queue
 *   for operator review. Only strikes with "appealed" status can be escalated.
 * @access Private (admin token only)
 */
router.post(
  "/strikes/:strikeId/escalate",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      const { strikeId } = req.params;

      const queueItem = strikeService.escalateToArbitration(strikeId);

      return res.status(200).json({
        success: true,
        message: "Strike escalated to arbitration queue for operator review.",
        queueItem,
      });
    } catch (err: any) {
      const status = err.message?.includes("not found") ? 404 : 409;
      return res.status(status).json({ success: false, error: err.message ?? "Escalation failed" });
    }
  },
);

/**
 * @route POST /api/v1/admin/strikes/:strikeId/arbitration/decide
 * @desc Decide an arbitration case. Uphold or overturn the strike.
 *   Body: { decision: "UPHELD" | "OVERTURNED" }
 * @access Private (admin token only)
 */
router.post(
  "/strikes/:strikeId/arbitration/decide",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      const { strikeId } = req.params;
      const { decision } = req.body ?? {};
      const decidedBy = req.auth?.userId ?? req.header("x-chronopay-admin-token") ?? "admin";

      if (!decision || !["UPHELD", "OVERTURNED"].includes(decision)) {
        return res.status(400).json({
          success: false,
          error: "decision must be either 'UPHELD' or 'OVERTURNED'",
        });
      }

      const result = strikeService.decideArbitration(strikeId, decision, decidedBy);

      return res.status(200).json({
        success: true,
        strike: result.strike,
        queueItem: result.queueItem,
        message: decision === "OVERTURNED"
          ? "Strike overturned by arbitration. Buyer reinstated."
          : "Strike upheld by arbitration. Penalty stands.",
      });
    } catch (err: any) {
      const status = err.message?.includes("not found") ? 404 : 409;
      return res.status(status).json({ success: false, error: err.message ?? "Arbitration decision failed" });
    }
  },
);

/**
 * @route GET /api/v1/admin/strikes/arbitration/queue
 * @desc Get the arbitration queue for operator review.
 *   Query params: ?status=pending|decided
 * @access Private (admin token only)
 */
router.get(
  "/strikes/arbitration/queue",
  requireAdminToken,
  (req: Request, res: Response) => {
    const status = req.query.status as string | undefined;
    const validStatus = status === "pending" || status === "decided" ? status : undefined;

    const queue = strikeService.getArbitrationQueue(validStatus);

    return res.status(200).json({
      success: true,
      queue,
      total: queue.length,
    });
  },
);

export default router;
