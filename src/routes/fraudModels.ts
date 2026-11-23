/**
 * fraudModels.ts (admin route)
 * -----------------------------
 * Routes mounted under `/api/v1/admin/fraud-models`.
 *
 * POST /promote        – promote a new weight distribution (single-admin)
 * GET  /list           – list registered model versions
 * GET  /history        – promotion history used by rollback (#455)
 * POST /rollback/initiate  (#455) – Admin A initiates a rollback
 * POST /rollback/approve   (#455) – Admin B approves and executes it
 *
 * Every successful promotion is recorded in the rollback history so
 * rollback/initiate can reference the prior champion automatically.
 *
 * Propagation guarantee: approve() calls registry.promote() synchronously.
 * The routing snapshot is updated in-process before the HTTP response is
 * sent — well under the 60-second SLO.
 */

import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import { requireAuthenticatedActor } from "../middleware/auth.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import {
  FraudModelRegistryError,
  getFraudModelRegistry,
} from "../services/fraudModelRegistry.js";
import {
  initiateRollback,
  approveRollback,
  recordPromotion,
  getPromotionHistory,
} from "../services/fraudModelRollback.js";
import { AUDIT_SCHEMA_VERSION } from "../types/auditEvent.js";

const router = Router();

function isValidationError(err: unknown): err is FraudModelRegistryError {
  return err instanceof FraudModelRegistryError;
}

// ---------------------------------------------------------------------------
// POST /promote
// ---------------------------------------------------------------------------

router.post("/promote", requireAdminToken, async (req: Request, res: Response) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const weights =
    body.weights && typeof body.weights === "object" && !Array.isArray(body.weights)
      ? body.weights
      : null;
  const tenantOverrides =
    body.tenantOverrides &&
    typeof body.tenantOverrides === "object" &&
    !Array.isArray(body.tenantOverrides)
      ? body.tenantOverrides
      : {};

  if (!weights) {
    return res.status(400).json({
      success: false,
      code: "BAD_REQUEST",
      error:
        "Request body must include `weights` as an object map of version -> integer in [0,100].",
    });
  }

  const registry = getFraudModelRegistry();
  const { errors, warnings } = registry.validateWeights(weights, tenantOverrides);
  if (errors.length > 0) {
    await defaultAuditLogger.log(
      "FRAUD_MODEL_PROMOTE_REJECTED",
      {
        method: req.method,
        body: { weights, tenantOverrides },
        context: {
          rejectedReason: errors.map((e) => e.code).join(","),
          schemaVersion: AUDIT_SCHEMA_VERSION,
          nonFatalWarnings: warnings.map((w) => w.code),
        },
      },
      {
        actorIp: req.ip || req.socket?.remoteAddress,
        resource: req.originalUrl,
        status: "rejected",
      },
    );
    return res.status(400).json({
      success: false,
      code: errors[0].code,
      errors: errors.map((e) => ({ code: e.code, message: e.message })),
      warnings,
    });
  }

  // Audit-first before state mutation.
  await defaultAuditLogger.log(
    "FRAUD_MODEL_PROMOTED",
    {
      method: req.method,
      body: { weights, tenantOverrides },
      context: {
        schemaVersion: AUDIT_SCHEMA_VERSION,
        nonFatalWarnings: warnings.map((w) => w.code),
      },
    },
    {
      actorIp: req.ip || req.socket?.remoteAddress,
      resource: req.originalUrl,
      status: "attempted",
    },
  );

  try {
    const actorId = req.header("x-chronopay-admin-token") ?? "admin";
    const result = registry.promote({ weights, tenantOverrides }, actorId);

    // Record in rollback history so rollback/initiate can reference this.
    recordPromotion({
      snapshotId: result.snapshot.snapshotId,
      request: { weights, tenantOverrides },
      promotedAt: new Date().toISOString(),
      promotedBy: actorId,
    });

    await defaultAuditLogger
      .log(
        "FRAUD_MODEL_PROMOTED",
        {
          method: req.method,
          body: { weights, tenantOverrides },
          context: {
            schemaVersion: AUDIT_SCHEMA_VERSION,
            snapshotId: result.snapshot.snapshotId,
            removedVersions: result.removedVersions,
            removedOverrides: result.removedOverrides,
            nonFatalWarnings: result.warnings.map((w) => w.code),
          },
        },
        {
          actorIp: req.ip || req.socket?.remoteAddress,
          resource: req.originalUrl,
          status: 200,
        },
      )
      .catch(() => undefined);

    return res.status(200).json({
      success: true,
      snapshot: serializeSnapshot(result.snapshot),
      removedVersions: result.removedVersions,
      removedOverrides: result.removedOverrides,
      warnings: result.warnings,
    });
  } catch (err) {
    if (isValidationError(err)) {
      return res.status(409).json({ success: false, code: err.code, error: err.message });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /list
// ---------------------------------------------------------------------------

router.get("/list", requireAdminToken, (_req: Request, res: Response) => {
  const registry = getFraudModelRegistry();
  return res.status(200).json({ success: true, models: registry.listModels() });
});

// ---------------------------------------------------------------------------
// GET /history  (#455)
// ---------------------------------------------------------------------------

/**
 * @route GET /api/v1/admin/fraud-models/history
 * @desc  Promotion history (newest-first) used by rollback to resolve the
 *        prior champion. Up to MAX_HISTORY (20) entries are kept in memory
 *        and in Redis.
 * @access Private (admin token only)
 */
router.get("/history", requireAdminToken, (_req: Request, res: Response) => {
  return res.status(200).json({ success: true, history: getPromotionHistory() });
});

// ---------------------------------------------------------------------------
// POST /rollback/initiate  (#455)
// ---------------------------------------------------------------------------

/**
 * @route POST /api/v1/admin/fraud-models/rollback/initiate
 * @desc  Admin A initiates a rollback to the prior (or specified) champion.
 *        Body: { reason: string, targetSnapshotId?: string }
 *        Returns rollbackId that Admin B must approve within 5 minutes.
 * @access Private (dual-admin: initiator must differ from approver)
 */
router.post(
  "/rollback/initiate",
  requireAuthenticatedActor(["admin"]),
  async (req: Request, res: Response) => {
    const initiatorId = req.auth?.userId;
    if (!initiatorId) {
      return res.status(401).json({ success: false, error: "Missing admin identity" });
    }

    const { reason, targetSnapshotId } = req.body ?? {};

    void defaultAuditLogger
      .log(
        "FRAUD_MODEL_ROLLBACK_INITIATED",
        {
          context: {
            initiatorId,
            reason: typeof reason === "string" ? reason : "",
            targetSnapshotId: targetSnapshotId ?? null,
          },
        },
        { actorIp: req.ip ?? "unknown", resource: req.originalUrl, status: "attempted" },
      )
      .catch(() => {});

    try {
      const result = initiateRollback({
        initiatorId,
        reason: typeof reason === "string" ? reason : "",
        targetSnapshotId:
          typeof targetSnapshotId === "string" ? targetSnapshotId : undefined,
      });

      return res.status(202).json({
        success: true,
        message:
          "Rollback initiated. Awaiting approval from a different admin within 5 minutes.",
        rollbackId: result.rollbackId,
        targetSnapshotId: result.targetSnapshotId,
        expiresAt: result.expiresAt,
      });
    } catch (err: any) {
      const code: string = err.code ?? "ROLLBACK_ERROR";
      const status =
        code === "NO_PRIOR_VERSION" || code === "SNAPSHOT_NOT_FOUND"
          ? 404
          : code === "ALREADY_CURRENT"
          ? 409
          : code === "CHANGE_FREEZE"
          ? 423
          : code === "REASON_TOO_SHORT" || code === "MISSING_ACTOR"
          ? 400
          : 500;
      return res.status(status).json({ success: false, code, error: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /rollback/approve  (#455)
// ---------------------------------------------------------------------------

/**
 * @route POST /api/v1/admin/fraud-models/rollback/approve
 * @desc  Admin B completes the dual-admin rollback.
 *        Must be a DIFFERENT admin from the initiator.
 *        Snapshot swap is synchronous — propagation completes in <1 s (SLO: 60 s).
 *        Body: { rollbackId: string }
 * @access Private (dual-admin: approver must differ from initiator)
 */
router.post(
  "/rollback/approve",
  requireAuthenticatedActor(["admin"]),
  async (req: Request, res: Response) => {
    const approverId = req.auth?.userId;
    if (!approverId) {
      return res.status(401).json({ success: false, error: "Missing admin identity" });
    }

    const { rollbackId } = req.body ?? {};
    if (!rollbackId || typeof rollbackId !== "string" || !rollbackId.trim()) {
      return res.status(400).json({ success: false, error: "rollbackId is required" });
    }

    try {
      const result = await approveRollback({
        rollbackId: rollbackId.trim(),
        approverId,
      });

      void defaultAuditLogger
        .log(
          "FRAUD_MODEL_ROLLBACK_APPLIED",
          {
            context: {
              rollbackId: rollbackId.trim(),
              approverId,
              newSnapshotId: result.snapshotId,
              propagationMs: result.propagationMs,
            },
          },
          { actorIp: req.ip ?? "unknown", resource: req.originalUrl, status: 200 },
        )
        .catch(() => {});

      return res.status(200).json({
        success: true,
        message: `Fraud model rolled back. New snapshot ${result.snapshotId} is active.`,
        snapshotId: result.snapshotId,
        versions: result.versions,
        propagationMs: result.propagationMs,
      });
    } catch (err: any) {
      const code: string = err.code ?? "ROLLBACK_ERROR";
      const status =
        code === "NOT_FOUND"
          ? 404
          : code === "EXPIRED"
          ? 410
          : code === "SAME_ADMIN"
          ? 403
          : code === "CHANGE_FREEZE"
          ? 423
          : code === "MISSING_ACTOR"
          ? 400
          : 500;
      return res.status(status).json({ success: false, code, error: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// Serialization helper
// ---------------------------------------------------------------------------

function serializeSnapshot(snap: {
  snapshotId: string;
  cumulative: Array<{ upper: number; version: string }>;
  overrides: Map<string, string>;
  defaultVersion: string;
  versions: Set<string>;
}): object {
  return {
    snapshotId: snap.snapshotId,
    cumulative: snap.cumulative.map((c) => ({ ...c })),
    overrides: Object.fromEntries(snap.overrides.entries()),
    defaultVersion: snap.defaultVersion,
    versions: Array.from(snap.versions),
  };
}

export default router;
