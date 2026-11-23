import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import { getTzDriftMetricsSnapshot } from "../metrics/tzDriftMetrics.js";
import { getLastScanFindings } from "../scheduler/tzDriftMonitor.js";

const router = Router();

// ─── Timezone Drift Monitor Admin API ─────────────────────────────────────────

/**
 * @route GET /api/v1/admin/tz-drift/metrics
 * @desc Retrieve the latest timezone drift scan snapshot including
 *   tenant-scoped ambiguous/missing-TZ counts and last scan timestamp.
 * @access Private (admin token only)
 */
router.get(
  "/tz-drift/metrics",
  requireAdminToken,
  (_req: Request, res: Response) => {
    try {
      const snapshot = getTzDriftMetricsSnapshot();
      return res.status(200).json({ success: true, snapshot });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to retrieve TZ drift metrics",
      });
    }
  },
);

/**
 * @route GET /api/v1/admin/tz-drift/offenders
 * @desc Sample offending slot rows from the last timezone drift scan.
 *   Query params:
 *     tenant    – filter by professionalId
 *     severity  – filter by severity (critical, warning, info)
 *     category  – filter by category (missing_tz, ambiguous, metadata)
 *     limit     – max results (default 50, max 200)
 *     offset    – pagination offset (default 0)
 * @access Private (admin token only)
 */
router.get(
  "/tz-drift/offenders",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      let findings = getLastScanFindings();

      // Apply filters
      if (typeof req.query.tenant === "string") {
        findings = findings.filter((f) => f.professionalId === req.query.tenant);
      }
      if (
        typeof req.query.severity === "string" &&
        ["critical", "warning", "info"].includes(req.query.severity)
      ) {
        findings = findings.filter((f) => f.severity === req.query.severity);
      }
      if (
        typeof req.query.category === "string" &&
        ["missing_tz", "ambiguous", "metadata"].includes(req.query.category)
      ) {
        findings = findings.filter((f) => f.category === req.query.category);
      }

      // Pagination
      let limit = 50;
      let offset = 0;
      if (req.query.limit !== undefined) {
        const parsed = parseInt(String(req.query.limit), 10);
        if (!isNaN(parsed) && parsed >= 1 && parsed <= 200) {
          limit = parsed;
        }
      }
      if (req.query.offset !== undefined) {
        const parsed = parseInt(String(req.query.offset), 10);
        if (!isNaN(parsed) && parsed >= 0) {
          offset = parsed;
        }
      }

      const total = findings.length;
      const page = findings.slice(offset, offset + limit);

      return res.status(200).json({
        success: true,
        offenders: page,
        total,
        limit,
        offset,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to retrieve TZ drift offenders",
      });
    }
  },
);

export default router;
