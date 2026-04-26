import type { NextFunction, Request, Response } from "express";
import { jwtVerify } from "jose";
import {
  ForbiddenError,
  InternalServerError,
  UnauthorizedError,
} from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";
import { sendErrorResponse } from "../errors/sendError.js";

export type ChronoPayRole = "customer" | "admin" | "professional";

export interface AuthContext {
  userId: string;
  role: ChronoPayRole;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}

export async function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const authHeader =
      (typeof req.header === "function" ? req.header("authorization") : undefined) ??
      (typeof req.headers?.authorization === "string" ? req.headers.authorization : undefined);
    const jwtSecret = process.env.JWT_SECRET;

    if (!authHeader) {
      if (!jwtSecret) {
        return next();
      }

      return sendErrorResponse(
        res,
        new UnauthorizedError(
          "Authorization header is required",
          ERROR_CODES.AUTHENTICATION_REQUIRED.code,
        ),
        req,
      );
    }

    if (!authHeader.startsWith("Bearer ")) {
      return sendErrorResponse(
        res,
        new UnauthorizedError(
          "Authorization header must use Bearer scheme",
          ERROR_CODES.INVALID_TOKEN.code,
        ),
        req,
      );
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) {
      return sendErrorResponse(
        res,
        new UnauthorizedError(
          "Bearer token is missing",
          ERROR_CODES.INVALID_TOKEN.code,
        ),
        req,
      );
    }

    if (!jwtSecret) {
      return sendErrorResponse(
        res,
        new InternalServerError("Authentication middleware error"),
        req,
      );
    }

    const { payload } = await jwtVerify(token, new TextEncoder().encode(jwtSecret));
    req.user = payload as Request["user"];
    next();
  } catch {
    return sendErrorResponse(
      res,
      new UnauthorizedError(
        "Invalid or expired token",
        ERROR_CODES.INVALID_TOKEN.code,
      ),
      req,
    );
  }
}

/**
 * Require a trusted upstream identity header for protected routes.
 */
export function requireAuthenticatedActor(
  allowedRoles: ChronoPayRole[] = ["customer", "admin"],
) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const rawUserId = req.header("x-chronopay-user-id");
    const rawRole = req.header("x-chronopay-role");

    if (!rawUserId || rawUserId.trim().length === 0) {
      emitAuthAudit(req, "AUTH_MISSING", 401);
      return sendErrorResponse(
        res,
        new UnauthorizedError(
          "Authentication required.",
          ERROR_CODES.AUTHENTICATION_REQUIRED.code,
        ),
        req,
      );
    }

    const role = parseRole(rawRole);
    if (!allowedRoles.includes(role)) {
      // Safe to log the resolved role — it is a controlled enum value, not a raw header.
      emitAuthAudit(req, "AUTH_FORBIDDEN", 403, { role });
      return sendErrorResponse(
        res,
        new ForbiddenError(
          "Role is not authorized for this action.",
          ERROR_CODES.INSUFFICIENT_PERMISSIONS.code,
        ),
        req,
      );
    }

    req.auth = {
      userId: rawUserId.trim(),
      role,
    };

    (req as any).logContext = { userId: rawUserId.trim() };

    next();
  };
}

function parseRole(rawRole: string | undefined): ChronoPayRole {
  if (!rawRole || rawRole.trim().length === 0) {
    return "customer";
  }

  const normalized = rawRole.trim().toLowerCase();
  if (
    normalized === "customer" ||
    normalized === "admin" ||
    normalized === "professional"
  ) {
    return normalized;
  }

  return "professional";
}

export const authenticateToken = requireAuthenticatedActor;
