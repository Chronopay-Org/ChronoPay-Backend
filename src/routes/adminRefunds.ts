import { Router, type Request, type Response } from "express";
import { populateAdminActor, requireAdminToken } from "../middleware/authorization.js";
import { requireFreshMfa } from "../middleware/requireFreshMfa.js";
import { RefundService } from "../services/refund.js";

const router = Router();

// --- Refund Routes ---

/**
 * @route POST /api/v1/admin/refunds
 * @desc Create a partial refund against a completed payment session.
 *       Enforces the invariant that sum of refunds <= captured amount.
 * @header x-chronopay-mfa — fresh MFA challenge token (from POST /api/v1/auth/mfa/verify).
 *       401 when missing/expired, 403 when bound to a different subject.
 * @access Private (admin token + MFA step-up)
 */
/**
 * @openapi
 * /api/v1/admin/refunds:
 *   post:
 *     summary: Create a partial refund
 *     description: >
 *       Creates a partial refund against a completed payment session.
 *       Requires admin token authentication plus a fresh MFA step-up
 *       challenge (subject bound to the caller, default freshness 15 minutes).
 *     tags: [Admin]
 *     security:
 *       - adminTokenAuth: []
 *     parameters:
 *       - in: header
 *         name: x-chronopay-mfa
 *         required: true
 *         schema:
 *           type: string
 *         description: >
 *           Fresh MFA challenge token from POST /api/v1/auth/mfa/verify.
 *           401 when missing or older than the freshness window, 403 when
 *           issued for a different subject.
 *     responses:
 *       201:
 *         description: Refund created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 refund:
 *                   type: object
 *                   description: The created refund
 *       401:
 *         description: Missing admin token, or missing/expired MFA challenge
 *       403:
 *         description: Invalid admin token, or MFA challenge for another subject
 */
router.post("/refunds", requireAdminToken, populateAdminActor, requireFreshMfa(), async (req: Request, res: Response) => {
  try {
    const { paymentId, amountCents, currency, reason, refundedBy } = req.body;

    if (!paymentId) {
      return res.status(400).json({ success: false, error: "paymentId is required" });
    }
    if (!amountCents || typeof amountCents !== "number" || amountCents <= 0) {
      return res.status(400).json({ success: false, error: "amountCents must be a positive integer" });
    }

    const refund = await RefundService.createRefundTraced({
      paymentId,
      amountCents,
      currency,
      reason,
      refundedBy,
    });

    return res.status(201).json({ success: true, refund });
  } catch (error: any) {
    const status = error.status ?? 500;
    return res.status(status).json({
      success: false,
      error: error.message ?? "Refund creation failed",
      code: error.code,
      details: error.details,
    });
  }
});

export default router;
