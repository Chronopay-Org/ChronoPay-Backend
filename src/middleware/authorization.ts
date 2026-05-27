import { NextFunction, Request, Response } from "express";
import {
  ConfigurationError,
  ForbiddenError,
  UnauthorizedError,
} from "../errors/AppError.js";
import { sendErrorResponse } from "../errors/sendError.js";

const ADMIN_TOKEN_HEADER = "x-chronopay-admin-token";

export function requireAdminToken(req: Request, res: Response, next: NextFunction) {
  const configuredToken = process.env.CHRONOPAY_ADMIN_TOKEN;

  if (!configuredToken) {
    return sendErrorResponse(
      res,
      new ConfigurationError("Update slot authorization is not configured"),
      req,
    );
  }

  const providedToken = req.header(ADMIN_TOKEN_HEADER);

  if (!providedToken) {
    return sendErrorResponse(
      res,
      new UnauthorizedError(`Missing required header: ${ADMIN_TOKEN_HEADER}`),
      req,
    );
  }

  if (providedToken !== configuredToken) {
    return sendErrorResponse(res, new ForbiddenError("Invalid admin token"), req);
  }

  return next();
}