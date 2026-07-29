// @ts-nocheck
/**
 * partnerQuota.ts
 *
 * Self-serve dashboard endpoint for partner token quota visibility.
 *
 * Routes:
 *   GET /api/v1/partner/quota  — returns current quota status for the
 *                                authenticated token.
 *
 * Place AFTER apiKeyAuth middleware so that req.apiKeyId is populated.
 */

import { Router, Request, Response } from "express";
import { getQuotaStatus, SqlQuotaStore } from "../services/partnerQuotaService.js";
import { getPool } from "../db/connection.js";

const router = Router();

/**
 * GET /api/v1/partner/quota
 *
 * Returns the current daily and monthly quota usage for the API token
 * identified by the `x-api-key` header.
 *
 * @openapi
 * /api/v1/partner/quota:
 *   get:
 *     tags: [Partner]
 *     summary: Get current quota status for the authenticated token
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Quota status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     tokenId:
 *                       type: string
 *                     dailyUsed:
 *                       type: integer
 *                     dailyLimit:
 *                       type: integer
 *                     monthlyUsed:
 *                       type: integer
 *                     monthlyLimit:
 *                       type: integer
 *                     dailyPercentUsed:
 *                       type: number
 *                     monthlyPercentUsed:
 *                       type: number
 *                     dailyResetAt:
 *                       type: string
 *                       format: date-time
 *                     monthlyResetAt:
 *                       type: string
 *                       format: date-time
 *                     timezone:
 *                       type: string
 *       401:
 *         description: Missing or invalid API key
 */
router.get("/quota", async (req: Request, res: Response) => {
  try {
    // The apiKeyAuth middleware populates req.apiKeyId.
    // If not present, the request must identify via other means (header-based auth).
    const tokenId = req.apiKeyId ?? req.auth?.userId;

    if (!tokenId) {
      return res.status(401).json({
        success: false,
        error: "Authentication required. Provide an API key via x-api-key header.",
      });
    }

    const pool = getPool();
    const store = new SqlQuotaStore(pool);
    const status = await getQuotaStatus(tokenId, store);

    res.json({
      success: true,
      data: status,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: "Failed to retrieve quota status.",
    });
  }
});

export default router;
