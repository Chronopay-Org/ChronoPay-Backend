import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import type { LocalIntentStatus } from "../services/escrowDriftReconciler.js";

const router = Router();

// ─── Escrow Drift Override API ───────────────────────────────────────────────

/**
 * In-memory reference to the escrow drift reconciler, set by the app
 * bootstrap when a reconciler is active. Tests can replace this with
 * a mock reconciler.
 */
let _driftReconciler: {
  manualOverride(
    slotId: string,
    targetStatus: LocalIntentStatus,
    reason: string,
    actorIp: string,
  ): Promise<{ previousState: unknown; newState: unknown }>;
} | null = null;

export function setDriftReconciler(
  reconciler: NonNullable<typeof _driftReconciler>,
): void {
  _driftReconciler = reconciler;
}

function getDriftReconciler() {
  return _driftReconciler;
}

const VALID_INTENT_STATUSES: ReadonlySet<LocalIntentStatus> = new Set([
  "pending",
  "confirmed",
  "cancelled",
  "expired",
]);

/**
 * @route POST /api/v1/admin/escrow/drift/override
 * @desc Manually override a booking intent's escrow state to resolve drift.
 *   This is a privileged operation that must only be used after careful
 *   forensic investigation. Every override is audited.
 *
 *   Body:
 *     slotId       – the slot to override (required)
 *     targetStatus – new intent status (pending|confirmed|cancelled|expired)
 *     reason       – forensic justification (required, min 20 chars)
 *
 * @access Private (admin token only)
 */
router.post(
  "/escrow/drift/override",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const reconciler = getDriftReconciler();
      if (!reconciler) {
        return res.status(503).json({
          success: false,
          error: "Escrow drift reconciler is not running",
        });
      }

      const { slotId, targetStatus, reason } = req.body as {
        slotId?: string;
        targetStatus?: string;
        reason?: string;
      };

      // Validate slotId
      if (!slotId || typeof slotId !== "string" || slotId.trim() === "") {
        return res.status(400).json({
          success: false,
          error: "slotId is required and must be a non-empty string",
        });
      }

      // Validate targetStatus
      if (!targetStatus || typeof targetStatus !== "string") {
        return res.status(400).json({
          success: false,
          error: `targetStatus is required and must be one of: ${Array.from(VALID_INTENT_STATUSES).join(", ")}`,
        });
      }

      if (!VALID_INTENT_STATUSES.has(targetStatus as LocalIntentStatus)) {
        return res.status(400).json({
          success: false,
          error: `Invalid targetStatus "${targetStatus}". Must be one of: ${Array.from(VALID_INTENT_STATUSES).join(", ")}`,
        });
      }

      // Validate reason (min 20 chars for forensic justification, max 2000 for abuse prevention)
      if (!reason || typeof reason !== "string" || reason.trim().length < 20) {
        return res.status(400).json({
          success: false,
          error: "reason is required and must be at least 20 characters (forensic justification)",
        });
      }

      if (reason.trim().length > 2000) {
        return res.status(400).json({
          success: false,
          error: "reason must be at most 2000 characters",
        });
      }

      const actorIp = req.ip ?? "unknown";
      const result = await reconciler.manualOverride(
        slotId.trim(),
        targetStatus as LocalIntentStatus,
        reason.trim(),
        actorIp,
      );

      // Audit the override
      void defaultAuditLogger.log(
        "escrow.drift.override.applied",
        {
          context: {
            slotId: slotId.trim(),
            targetStatus,
            reason: reason.trim(),
            previousStatus: (result.previousState as any)?.intentStatus ?? "unknown",
            actorIp,
          },
          method: req.method,
        },
        { actorIp, resource: `slot:${slotId.trim()}`, status: 200 },
      );

      return res.status(200).json({
        success: true,
        slotId: slotId.trim(),
        previousState: result.previousState,
        newState: result.newState,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Manual override failed",
      });
    }
  },
);

export default router;
