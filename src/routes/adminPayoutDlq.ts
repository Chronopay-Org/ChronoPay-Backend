import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import { getPayoutDlqStore, type PayoutDlqStatus } from "../services/payoutDlqStore.js";

const router = Router();

// ─── Payout DLQ Inspection API ──────────────────────────────────────────────


/**
 * Validated PayoutDlqStatus values.
 */
const VALID_DLQ_STATUSES: PayoutDlqStatus[] = ["pending", "reprocessed", "inspected"];

function isValidDlqStatus(value: string): value is PayoutDlqStatus {
  return VALID_DLQ_STATUSES.includes(value as PayoutDlqStatus);
}

/**
 * @route GET /api/v1/admin/payout-dlq
 * @desc List payout DLQ entries with optional filtering by supplierId, errorClass,
 *       status, and full-text search. All payloads are masked server-side.
 *   Query params:
 *     supplierId  – filter by supplier ID
 *     errorClass  – filter by error class (case-insensitive)
 *     status      – filter by status (pending, reprocessed, inspected)
 *     search      – full-text search across supplierId, errorClass, errorMessage, id
 *     limit       – max results (default 50, max 200)
 *     offset      – pagination offset (default 0)
 * @access Private (admin token only)
 */
router.get(
  "/payout-dlq",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      const store = getPayoutDlqStore();

      // Validate status filter if provided
      if (req.query.status !== undefined) {
        const statusVal = String(req.query.status);
        if (!isValidDlqStatus(statusVal)) {
          return res.status(400).json({
            success: false,
            error: `Invalid status. Must be one of: ${VALID_DLQ_STATUSES.join(", ")}`,
          });
        }
      }

      // Validate limit
      if (req.query.limit !== undefined) {
        const lim = parseInt(String(req.query.limit), 10);
        if (isNaN(lim) || lim < 1 || lim > 200) {
          return res.status(400).json({
            success: false,
            error: "limit must be between 1 and 200",
          });
        }
      }

      // Validate offset
      if (req.query.offset !== undefined) {
        const off = parseInt(String(req.query.offset), 10);
        if (isNaN(off) || off < 0) {
          return res.status(400).json({
            success: false,
            error: "offset must be a non-negative integer",
          });
        }
      }

      const result = store.list({
        supplierId:
          typeof req.query.supplierId === "string"
            ? req.query.supplierId
            : undefined,
        errorClass:
          typeof req.query.errorClass === "string"
            ? req.query.errorClass
            : undefined,
        status:
          typeof req.query.status === "string" &&
          isValidDlqStatus(req.query.status)
            ? req.query.status
            : undefined,
        search:
          typeof req.query.search === "string"
            ? req.query.search
            : undefined,
        limit: req.query.limit !== undefined
          ? parseInt(String(req.query.limit), 10)
          : undefined,
        offset: req.query.offset !== undefined
          ? parseInt(String(req.query.offset), 10)
          : undefined,
      });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to list payout DLQ entries",
      });
    }
  },
);

/**
 * @route GET /api/v1/admin/payout-dlq/:entryId
 * @desc Retrieve a single payout DLQ entry with masked payload.
 *       Logs an audit event for each inspection.
 * @access Private (admin token only)
 */
router.get(
  "/payout-dlq/:entryId",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      const { entryId } = req.params;

      if (
        !entryId ||
        typeof entryId !== "string" ||
        entryId.trim() === ""
      ) {
        return res
          .status(400)
          .json({ success: false, error: "Missing entryId" });
      }

      const store = getPayoutDlqStore();

      // Check existence first
      const raw = store.getByIdRaw(entryId.trim());
      if (!raw) {
        return res.status(404).json({
          success: false,
          error: `Payout DLQ entry '${entryId}' not found`,
        });
      }

      // Mark as inspected, then read the updated masked entry
      store.markInspected(entryId.trim());
      const entry = store.getById(entryId.trim())!;

      void defaultAuditLogger.log(
        "payout.dlq.inspected",
        {
          body: {
            dlqEntryId: entry.id,
            supplierId: entry.supplierId,
            errorClass: entry.errorClass,
          },
          context: {
            inspectorIp: req.ip ?? "unknown",
          },
        },
        {
          resource: `/api/v1/admin/payout-dlq/${entry.id}`,
          status: 200,
        },
      );

      return res.status(200).json({ success: true, entry });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to retrieve payout DLQ entry",
      });
    }
  },
);

export default router;
