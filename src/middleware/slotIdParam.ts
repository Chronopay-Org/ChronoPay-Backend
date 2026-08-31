import { Request, Response, NextFunction } from "express";
import { BadRequestError } from "../errors/AppError.js";
import { sendErrorResponse } from "../errors/sendError.js";

export function parseSlotIdParam(req: Request, res: Response, next: NextFunction): void {
  const rawId = String(req.params.id ?? "").trim();

  if (rawId.length === 0) {
    sendErrorResponse(res, new BadRequestError("Invalid slot id"), req);
    return;
  }

  const numericId = Number(rawId);
  const isNumericSlotId = Number.isInteger(numericId) && numericId > 0;
  const isLegacyStringId = /^[A-Za-z0-9_-]+$/.test(rawId);

  if (!isNumericSlotId && !isLegacyStringId) {
    sendErrorResponse(res, new BadRequestError("Invalid slot id"), req);
    return;
  }

  next();
}
