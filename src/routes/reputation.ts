/**
 * Reputation Transparency Routes
 *
 * Exposes owner-only endpoints for suppliers to view signals and weights driving their score.
 */

import { Router, type Request, type Response } from "express";
import {
  reputationTransparencyService,
  type ReputationSignalProjectionResponse,
} from "../services/reputationTransparencyService.js";
import { recordReputationQuery } from "../metrics.js";
import { createAuthAwareRateLimiter } from "../middleware/rateLimiter.js";

const router = Router();

const TENANT_ID_MAX_LENGTH = 128;
const TENANT_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * Shape of the JWT payload attached to `req.user` by the auth middleware.
 */
interface JwtUser {
  sub?: string;
  id?: string;
  role?: string;
  tenantId?: string;
}

/**
 * Shape of the legacy `req.auth` context attached by header-based auth.
 */
interface AuthContext {
  userId?: unknown;
  role?: unknown;
}

/**
 * Verified caller identity used by the reputation authorization checks.
 */
interface Actor {
  userId: string;
  role: string | null;
  tenantId: string | null;
}

/**
 * Normalise an optional header value into a trimmed, non-empty string.
 */
function readNonEmptyString(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validate the `x-tenant-id` header.
 *
 * A malformed tenant header is ignored rather than rejected so that legacy
 * clients without tenant scoping keep their existing authorization result.
 * Valid values are 1..128 characters from a conservative, URL-safe charset.
 */
export function parseValidTenantId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const tenantId = raw.trim();
  if (tenantId.length === 0) return undefined;
  if (tenantId.length > TENANT_ID_MAX_LENGTH) return undefined;
  if (!TENANT_ID_PATTERN.test(tenantId)) return undefined;
  return tenantId;
}

function readHeader(req: Request, names: string[]): string | null {
  for (const name of names) {
    const value = readNonEmptyString(req.headers[name]);
    if (value) return value;
  }
  return null;
}

/**
 * Extracts authenticated actor details from JWT payload or ChronoPay custom headers.
 * Returns `null` when the request carries no usable identity.
 */
function getAuthenticatedActor(req: Request): Actor | null {
  const tenantId = parseValidTenantId(req.headers["x-tenant-id"]) ?? null;

  const auth = req.auth as AuthContext | undefined;
  const authUserId = readNonEmptyString(auth?.userId);
  if (authUserId) {
    return {
      userId: authUserId,
      role: readNonEmptyString(auth?.role),
      tenantId,
    };
  }

  const jwtUser = req.user as JwtUser | undefined;
  if (jwtUser) {
    const jwtUserId =
      readNonEmptyString(jwtUser.sub) ?? readNonEmptyString(jwtUser.id);
    if (jwtUserId) {
      return {
        userId: jwtUserId,
        role: readNonEmptyString(jwtUser.role),
        tenantId,
      };
    }
  }

  const userId = readHeader(req, [
    "x-supplier-owner-id",
    "x-chronopay-user-id",
    "x-user-id",
  ]);
  if (!userId) return null;

  return {
    userId,
    role: readHeader(req, [
      "x-chronopay-role",
      "x-user-role",
      "x-role",
    ])?.toLowerCase() ?? null,
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
    const { supplierId } = req.params;
    const tenantId = parseValidTenantId(req.headers["x-tenant-id"]) ?? "unknown";
    const actor = getAuthenticatedActor(req);

    try {
      if (!actor) {
        recordReputationQuery(tenantId, "unauthorized");
        return res.status(401).json({
          success: false,
          error: "Authentication required to access reputation signals",
        });
      }

      const { isAuthorized, isNotFound, isForbidden } =
        reputationTransparencyService.verifyOwnership(
          supplierId,
          actor.userId,
          actor.role ?? undefined,
          actor.tenantId ?? undefined,
        );

      if (isNotFound) {
        recordReputationQuery(actor.tenantId ?? "unknown", "not_found");
        return res.status(404).json({
          success: false,
          error: `Supplier with ID '${supplierId}' was not found.`,
        });
      }

      if (isForbidden || !isAuthorized) {
        recordReputationQuery(actor.tenantId ?? "unknown", "forbidden");
        return res.status(403).json({
          success: false,
          error:
            "Access denied: you are not authorized to view this supplier's reputation signals.",
        });
      }

      const projection: ReputationSignalProjectionResponse =
        reputationTransparencyService.getSignalProjection(supplierId);

      return res.status(200).json({
        success: true,
        data: projection,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to retrieve reputation signals",
      });
    }
  },
);

export default router;
