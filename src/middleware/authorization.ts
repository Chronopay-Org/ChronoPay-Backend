import { NextFunction, Request, Response } from "express";
import { ConfigurationError, ForbiddenError, UnauthorizedError } from "../errors/AppError.js";
import { sendErrorResponse } from "../errors/sendError.js";
import { defaultAuditLogger } from "../services/auditLogger.js";

const ADMIN_TOKEN_HEADER = "x-chronopay-admin-token";

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

  if (providedToken !== configuredToken) {
    emitAdminTokenDeniedAudit(req, "AUTHZ_FORBIDDEN", 403);
    return sendErrorResponse(res, new ForbiddenError("Invalid admin token"), req);
  }

  return next();
}
