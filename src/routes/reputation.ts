/**
 * Reputation Transparency Routes
 *
 * Exposes owner-only endpoints for suppliers to view signals and weights driving their score.
 */

import { Router, type Request, type Response } from "express";
import { reputationTransparencyService } from "../services/reputationTransparencyService.js";
import { recordReputationQuery } from "../metrics.js";
import { createAuthAwareRateLimiter } from "../middleware/rateLimiter.js";

const router = Router();

/**
 * Extracts authenticated actor details from JWT payload or ChronoPay custom headers.
 */
function getAuthenticatedActor(req: Request): {
  userId: string | null;
  role: string | null;
  tenantId: string | null;
} {
  const tenantId = (req.headers["x-tenant-id"] as string)?.trim() || null;

  if (req.auth?.userId) {
    return {
      userId: req.auth.userId,
      role: req.auth.role || null,
      tenantId,
    };
  }

  if (req.user) {
    const userObj = req.user as any;
    return {
      userId: userObj.sub || userObj.id || null,
      role: userObj.role || null,
      tenantId,
    };
  }

  const userIdHeader =
    (req.headers["x-supplier-owner-id"] as string) ||
    (req.headers["x-chronopay-user-id"] as string) ||
    (req.headers["x-user-id"] as string);

  const roleHeader =
    (req.headers["x-chronopay-role"] as string) ||
    (req.headers["x-user-role"] as string) ||
    (req.headers["x-role"] as string);

  return {
    userId: userIdHeader ? userIdHeader.trim() : null,
    role: roleHeader ? roleHeader.trim().toLowerCase() : null,
    tenantId,
  };
}

/**
 * @route   GET /api/v1/suppliers/:supplierId/reputation/signals
 * @desc    Get aggregated signal breakdown & weights driving supplier reputation score
 * @access  Private (Supplier Owner or Admin only)
 */
router.get(
  "/:supplierId/reputation/signals",
  createAuthAwareRateLimiter(),
  (req: Request, res: Response) => {
  try {
    const { supplierId } = req.params;
    const actor = getAuthenticatedActor(req);

    if (!actor.userId) {
      recordReputationQuery(actor.tenantId || "unknown", "unauthorized");
      return res.status(401).json({
        success: false,
        error: "Authentication required to access reputation signals",
      });
    }

    const { isAuthorized, isNotFound, isForbidden } = reputationTransparencyService.verifyOwnership(
      supplierId,
      actor.userId,
      actor.role || undefined,
      actor.tenantId || undefined
    );

    if (isNotFound) {
      recordReputationQuery(actor.tenantId || "unknown", "not_found");
      return res.status(404).json({
        success: false,
        error: `Supplier with ID '${supplierId}' was not found.`,
      });
    }

    if (isForbidden || !isAuthorized) {
      recordReputationQuery(actor.tenantId || "unknown", "forbidden");
      return res.status(403).json({
        success: false,
        error: "Access denied: you are not authorized to view this supplier's reputation signals.",
      });
    }

    const projection = reputationTransparencyService.getSignalProjection(supplierId);

    return res.status(200).json({
      success: true,
      data: projection,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to retrieve reputation signals",
    });
  }
});

export default router;
