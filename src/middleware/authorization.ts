import { NextFunction, Request, Response } from "express";
import { ConfigurationError, ForbiddenError, UnauthorizedError } from "../errors/AppError.js";
import { sendErrorResponse } from "../errors/sendError.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import type { ChronoPayRole } from "./auth.js";
import type { VerifiedJwtPayload } from "../utils/jwt.js";
import { constantTimeEquals } from "../utils/constantTimeEquals.js";

const ADMIN_TOKEN_HEADER = "x-chronopay-admin-token";
const ADMIN_IDENTITY_HEADER = "x-chronopay-user-id";
const FALLBACK_ADMIN_ACTOR_ID = "admin";

type AdminTokenAuditAction = "AUTHZ_UNCONFIGURED" | "AUTHZ_MISSING" | "AUTHZ_FORBIDDEN";

/**
 * Emits a bounded audit event for a denied admin-token access.
 *
 * The provided token value is never logged; only the header presence and the
 * HTTP status are recorded, so attacker-controlled strings cannot be written
 * into audit storage.
 */
function emitAdminTokenDeniedAudit(
  req: Request,
  action: AdminTokenAuditAction,
  status: number,
): void {
  defaultAuditLogger
    .log({
      action,
      actorIp: req.ip || req.socket?.remoteAddress,
      resource: req.originalUrl,
      status,
      metadata: { method: req.method },
    })
    .catch(() => {});
}

export function requireAdminToken(req: Request, res: Response, next: NextFunction) {
  const configuredToken = process.env.CHRONOPAY_ADMIN_TOKEN;

  if (!configuredToken) {
    emitAdminTokenDeniedAudit(req, "AUTHZ_UNCONFIGURED", 503);
    return sendErrorResponse(
      res,
      new ConfigurationError("Update slot authorization is not configured"),
      req,
    );
  }

  const providedToken = req.header(ADMIN_TOKEN_HEADER);

  if (!providedToken) {
    emitAdminTokenDeniedAudit(req, "AUTHZ_MISSING", 401);
    return sendErrorResponse(
      res,
      new UnauthorizedError(`Missing required header: ${ADMIN_TOKEN_HEADER}`),
      req,
    );
  }

  if (!constantTimeEquals(providedToken, configuredToken)) {
    emitAdminTokenDeniedAudit(req, "AUTHZ_FORBIDDEN", 403);
    return sendErrorResponse(res, new ForbiddenError("Invalid admin token"), req);
  }

  return next();
}

/**
 * Populates `req.auth` on admin-token routes so that step-up middleware
 * mounted afterwards (notably `requireFreshMfa`) has a subject to bind the
 * MFA challenge to. Admin-token routes authenticate with
 * `x-chronopay-admin-token` only and never set `req.auth` themselves, so
 * without this middleware the MFA check would reject every request with
 * "Authentication required".
 *
 * The subject comes from the same `x-chronopay-user-id` header used by
 * `requireAuthenticatedActor`, so admins present a challenge issued to their
 * own account via `POST /api/v1/auth/mfa/verify`. Admin-token calls without
 * the identity header fall back to a stable `admin` subject.
 *
 * Mount order: `requireAdminToken`, `populateAdminActor`, `requireFreshMfa()`.
 * Only mount it on routes that actually need the actor; it deliberately does
 * not run inside `requireAdminToken` so other admin routes keep their
 * existing `req.auth === undefined` behaviour.
 */
export function populateAdminActor(req: Request, _res: Response, next: NextFunction) {
  if (req.auth?.userId) {
    return next();
  }

  const raw = req.headers[ADMIN_IDENTITY_HEADER];
  const headerValue = Array.isArray(raw) ? raw[0] : raw;
  const userId = typeof headerValue === "string" ? headerValue.trim() : "";

  req.auth = {
    userId: userId.length > 0 ? userId : FALLBACK_ADMIN_ACTOR_ID,
    role: "admin" as ChronoPayRole,
    claims: {} as VerifiedJwtPayload,
  };

  return next();
}
