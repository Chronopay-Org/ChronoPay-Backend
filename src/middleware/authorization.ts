import { NextFunction, Request, Response } from "express";

const ADMIN_TOKEN_HEADER = "x-chronopay-admin-token";

export function requireAdminToken(req: Request, res: Response, next: NextFunction) {
  const configuredToken = process.env.CHRONOPAY_ADMIN_TOKEN;

  if (!configuredToken) {
    return res.status(503).json({
      success: false,
      error: "Update slot authorization is not configured",
    });
  }

  const providedToken = req.header(ADMIN_TOKEN_HEADER);

  if (!providedToken) {
    return res.status(401).json({
      success: false,
      error: `Missing required header: ${ADMIN_TOKEN_HEADER}`,
    });
  }

  if (providedToken !== configuredToken) {
    return res.status(403).json({
      success: false,
      error: "Invalid admin token",
    });
  }

  return next();
}