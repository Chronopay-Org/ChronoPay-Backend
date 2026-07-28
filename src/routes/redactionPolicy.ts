import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import {
  swapPolicy,
  rollbackPolicy,
  getCurrentPolicy,
  getRollbackHistory,
} from "../utils/redactionPolicy.js";

const router = Router();

function extractActorIp(req: Request): string | undefined {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
    ?? req.ip;
}

/**
 * @route POST /api/v1/admin/redaction-policy/reload
 * @desc Hot-reload the PII redaction field policy without restarting the service.
 * @access Private (admin token only)
 */
router.post("/redaction-policy/reload", requireAdminToken, (req: Request, res: Response) => {
  try {
    const { fields } = req.body;

    if (!fields) {
      return res.status(400).json({
        success: false,
        error: "Request body must include a 'fields' array",
      });
    }

    const actorIp = extractActorIp(req);
    const result = swapPolicy({ fields }, actorIp);

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.status(200).json({
      success: true,
      version: result.policy.version,
      fieldCount: Array.from(result.policy.fields).length,
      updatedAt: result.policy.updatedAt,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message ?? "Failed to reload redaction policy",
    });
  }
});

/**
 * @route POST /api/v1/admin/redaction-policy/rollback
 * @desc Rollback to the previous redaction policy version.
 * @access Private (admin token only)
 */
router.post("/redaction-policy/rollback", requireAdminToken, (req: Request, res: Response) => {
  try {
    const actorIp = extractActorIp(req);
    const result = rollbackPolicy(actorIp);

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.status(200).json({
      success: true,
      version: result.policy.version,
      fieldCount: Array.from(result.policy.fields).length,
      updatedAt: result.policy.updatedAt,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message ?? "Failed to rollback redaction policy",
    });
  }
});

/**
 * @route GET /api/v1/admin/redaction-policy
 * @desc Get the current redaction policy version and metadata.
 * @access Private (admin token only)
 */
router.get("/redaction-policy", requireAdminToken, (_req: Request, res: Response) => {
  const policy = getCurrentPolicy();
  const history = getRollbackHistory();

  return res.status(200).json({
    success: true,
    version: policy.version,
    fieldCount: Array.from(policy.fields).length,
    updatedAt: policy.updatedAt,
    rollbackHistory: history,
  });
});

export default router;
