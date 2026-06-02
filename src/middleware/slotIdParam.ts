import { Request, Response, NextFunction } from "express";
import { BadRequestError } from "../errors/AppError.js";
import { sendErrorResponse } from "../errors/sendError.js";

export function parseSlotIdParam(req: Request, res: Response, next: NextFunction): void {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    sendErrorResponse(res, new BadRequestError("Invalid slot id"), req);
    return;
  }
  next();
}
