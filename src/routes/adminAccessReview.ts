import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import { accessReviewService } from "../services/accessReviewService.js";
import type {
  AttestationOutcome,
  ListAttestationsOptions,
  ListSnapshotsOptions,
  ReportFormat,
} from "../types/accessReview.js";

/**
 * SOC2 access-review admin routes.
 *
 * AccessReviewService owns snapshot generation, attestation rules and report
 * formatting. This module is the HTTP edge only: authentication, query/body
 * validation, and error-to-status mapping.
 *
 * Mounted by routes/admin.ts under /api/v1/admin, so paths here are relative
 * to that prefix.
 */

const ATTESTATION_OUTCOMES: readonly AttestationOutcome[] = [
  "approved",
  "rejected",
  "needs_revision",
];

/**
 * Maps a service error onto an HTTP status. The service distinguishes
 * "missing snapshot" (404) from contract violations like a missing reviewer,
 * a bad outcome, or a duplicate attestation (400).
 */
function handleServiceError(err: any, res: Response): Response {
  const message = err?.message ?? "Access review operation failed";
  if (/not found/i.test(message)) {
    return res.status(404).json({ success: false, error: message });
  }
  if (/required|invalid|already exists/i.test(message)) {
    return res.status(400).json({ success: false, error: message });
  }
  return res.status(500).json({ success: false, error: message });
}

/** Parses a positive-integer query param, falling back when absent/invalid. */
function readPositiveInt(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Only "csv" opts out of the default JSON representation. */
function readFormat(value: unknown): ReportFormat {
  return value === "csv" ? "csv" : "json";
}

const router = Router();

/**
 * @route POST /api/v1/admin/access-review/snapshots
 * @desc Capture the current role/permission hierarchy as a point-in-time
 *   snapshot. Idempotent per quarter unless ?force=true.
 * @access Private (admin token only)
 */
router.post("/access-review/snapshots", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const force = req.query.force === "true";
    const snapshot = await accessReviewService.createSnapshot(force);
    return res.status(201).json({ success: true, snapshot });
  } catch (err) {
    return handleServiceError(err, res);
  }
});

/**
 * @route GET /api/v1/admin/access-review/snapshots
 * @desc List captured snapshots. Query params: ?summaries=true&quarterLabel=&limit=&offset=
 * @access Private (admin token only)
 */
router.get("/access-review/snapshots", requireAdminToken, (req: Request, res: Response) => {
  try {
    const options: ListSnapshotsOptions = {};
    const limit = readPositiveInt(req.query.limit);
    const offset = readPositiveInt(req.query.offset);
    if (limit !== undefined) options.limit = limit;
    if (offset !== undefined) options.offset = offset;
    if (req.query.quarterLabel) {
      options.quarterLabel = req.query.quarterLabel as ListSnapshotsOptions["quarterLabel"];
    }

    // Summaries drop the (potentially large) per-role grant array.
    if (req.query.summaries === "true") {
      return res.status(200).json({ success: true, ...accessReviewService.listSnapshotSummaries(options) });
    }

    return res.status(200).json({ success: true, ...accessReviewService.listSnapshots(options) });
  } catch (err) {
    return handleServiceError(err, res);
  }
});

/**
 * @route GET /api/v1/admin/access-review/snapshots/:snapshotId
 * @desc Fetch a single snapshot with its full grant list.
 * @access Private (admin token only)
 */
router.get("/access-review/snapshots/:snapshotId", requireAdminToken, (req: Request, res: Response) => {
  try {
    const snapshot = accessReviewService.getSnapshot(req.params.snapshotId);
    if (!snapshot) {
      return res.status(404).json({
        success: false,
        error: `Snapshot not found: ${req.params.snapshotId}`,
      });
    }
    return res.status(200).json({ success: true, snapshot });
  } catch (err) {
    return handleServiceError(err, res);
  }
});

/**
 * @route GET /api/v1/admin/access-review/snapshots/:snapshotId/report
 * @desc Render the audit report for a snapshot. Query param: ?format=json|csv
 * @access Private (admin token only)
 */
router.get(
  "/access-review/snapshots/:snapshotId/report",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      const format = readFormat(req.query.format);
      const body = accessReviewService.generateFormattedReport(req.params.snapshotId, format);
      return res
        .status(200)
        .type(format === "csv" ? "text/csv" : "application/json")
        .send(body);
    } catch (err) {
      return handleServiceError(err, res);
    }
  },
);

/**
 * @route POST /api/v1/admin/access-review/snapshots/:snapshotId/attestations
 * @desc Record a reviewer's sign-off on a snapshot. One attestation per
 *   (snapshot, reviewer) pair; amendments go through the service's update path.
 * @access Private (admin token only)
 */
router.post(
  "/access-review/snapshots/:snapshotId/attestations",
  requireAdminToken,
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Validated here rather than relying on the service so the caller gets a
    // field-named message instead of the service's generic phrasing.
    if (typeof body.reviewer !== "string" || body.reviewer.trim().length === 0) {
      return res.status(400).json({ success: false, error: "reviewer is required" });
    }
    if (!ATTESTATION_OUTCOMES.includes(body.outcome as AttestationOutcome)) {
      return res.status(400).json({
        success: false,
        error: `outcome must be one of: ${ATTESTATION_OUTCOMES.join(", ")}`,
      });
    }

    try {
      const attestation = await accessReviewService.createAttestation(
        req.params.snapshotId,
        body.reviewer,
        body.outcome as AttestationOutcome,
        typeof body.notes === "string" ? body.notes : undefined,
      );
      return res.status(201).json({ success: true, attestation });
    } catch (err) {
      return handleServiceError(err, res);
    }
  },
);

/**
 * @route GET /api/v1/admin/access-review/attestations
 * @desc List attestations. Query params: ?snapshotId=&quarterLabel=&outcome=&limit=&offset=
 * @access Private (admin token only)
 */
router.get("/access-review/attestations", requireAdminToken, (req: Request, res: Response) => {
  try {
    const options: ListAttestationsOptions = {};
    const limit = readPositiveInt(req.query.limit);
    const offset = readPositiveInt(req.query.offset);
    if (limit !== undefined) options.limit = limit;
    if (offset !== undefined) options.offset = offset;
    if (req.query.snapshotId) options.snapshotId = req.query.snapshotId as string;
    if (req.query.quarterLabel) {
      options.quarterLabel = req.query.quarterLabel as ListAttestationsOptions["quarterLabel"];
    }
    if (req.query.outcome) options.outcome = req.query.outcome as AttestationOutcome;

    return res.status(200).json({ success: true, ...accessReviewService.listAttestations(options) });
  } catch (err) {
    return handleServiceError(err, res);
  }
});

/**
 * @route GET /api/v1/admin/access-review/gaps
 * @desc Detect quarters with no captured snapshot, i.e. unreviewed access.
 * @access Private (admin token only)
 */
router.get("/access-review/gaps", requireAdminToken, (req: Request, res: Response) => {
  try {
    const lookback = readPositiveInt(req.query.lookback) ?? 8;
    return res.status(200).json({ success: true, gaps: accessReviewService.detectGaps(lookback) });
  } catch (err) {
    return handleServiceError(err, res);
  }
});

/**
 * @route GET /api/v1/admin/access-review/bundled-report
 * @desc Bundle every attested snapshot's report. Query param: ?format=json|csv
 * @access Private (admin token only)
 */
router.get(
  "/access-review/bundled-report",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      const format = readFormat(req.query.format);
      const body =
        format === "csv"
          ? accessReviewService.generateAttestedReportsCsvBundle()
          : accessReviewService.generateAttestedReportsBundle();
      return res
        .status(200)
        .type(format === "csv" ? "text/csv" : "application/json")
        .send(body);
    } catch (err) {
      return handleServiceError(err, res);
    }
  },
);

export default router;
