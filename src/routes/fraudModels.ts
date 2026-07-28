/**
 * fraudModels.ts (admin route)
 * -----------------------------
 * `POST /api/v1/admin/fraud-models/promote`
 *   Body: { weights: { "<version>": <integer 0..100> }, tenantOverrides: { "<tenantId>": "<version>" } }
 *   Requires the `x-chronopay-admin-token` header.
 *   Emits a `FRAUD_MODEL_PROMOTED` audit event BEFORE mutating registry state.
 *   Validates that:
 *     - weights sum to exactly 100;
 *     - all versions in `weights` and `tenantOverrides` are registered;
 *     - every weight is a non-negative integer ≤ 100.
 *   Returns the new immutable `RoutingSnapshot` on success.
 *
 * This router is mounted under `/api/v1/admin/fraud-models` by `admin.ts`,
 * so the route paths here are RELATIVE — `/promote`, `/list`.
 */

import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import {
  FraudModelRegistryError,
  getFraudModelRegistry,
} from "../services/fraudModelRegistry.js";
import { AUDIT_SCHEMA_VERSION } from "../types/auditEvent.js";

const router = Router();

/**
 * Loud boundary check used to surface unexpected runtime errors as 500s
 * with a stable code, rather than letting them fall through to the generic
 * error envelope.
 */
function isValidationError(err: unknown): err is FraudModelRegistryError {
  return err instanceof FraudModelRegistryError;
}

router.post("/promote", requireAdminToken, async (req: Request, res: Response) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const weights =
    body.weights && typeof body.weights === "object" && !Array.isArray(body.weights)
      ? body.weights
      : null;
  const tenantOverrides =
    body.tenantOverrides && typeof body.tenantOverrides === "object" && !Array.isArray(body.tenantOverrides)
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

  // Audit-first: emit the intent BEFORE mutating state. The logger falls
  // back to a console error if the file write fails, so the request flow
  // is never blocked on disk I/O.
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
    const result = registry.promote(
      { weights, tenantOverrides },
      req.header("x-chronopay-admin-token") ?? "admin",
    );

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
      return res.status(409).json({
        success: false,
        code: err.code,
        error: err.message,
      });
    }
    throw err;
  }
});

router.get("/list", requireAdminToken, (_req: Request, res: Response) => {
  const registry = getFraudModelRegistry();
  const models = registry.listModels();
  return res.status(200).json({ success: true, models });
});

function serializeSnapshot(snap: {
  snapshotId: string;
  cumulative: Array<{ upper: number; version: string }>;
  overrides: Map<string, string>;
  defaultVersion: string;
  versions: Set<string>;
}): {
  snapshotId: string;
  cumulative: Array<{ upper: number; version: string }>;
  overrides: Record<string, string>;
  defaultVersion: string;
  versions: string[];
} {
  return {
    snapshotId: snap.snapshotId,
    cumulative: snap.cumulative.map((c) => ({ ...c })),
    overrides: Object.fromEntries(snap.overrides.entries()),
    defaultVersion: snap.defaultVersion,
    versions: Array.from(snap.versions),
  };
}

export default router;
