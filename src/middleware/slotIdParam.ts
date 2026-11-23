import { Request, Response, NextFunction } from "express";
import { BadRequestError } from "../errors/AppError.js";
import { sendErrorResponse } from "../errors/sendError.js";

/**
 * Canonical slot ids minted by SlotService (`slot-<uuid>`). Anything that is
 * neither a positive integer (legacy numeric ids) nor canonical is rejected
 * with 400 before it can reach a lookup.
 */
const CANONICAL_SLOT_ID_PATTERN =
  /^slot-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSlotIdParam(req: Request, res: Response, next: NextFunction): void {
  const rawId = String(req.params.id ?? "").trim();

  if (rawId.length === 0) {
    sendErrorResponse(res, new BadRequestError("Invalid slot id"), req);
    return;
  }

  const numericId = Number(rawId);
  const isNumericSlotId = Number.isInteger(numericId) && numericId > 0;
  const isCanonicalSlotId = CANONICAL_SLOT_ID_PATTERN.test(rawId);

  if (!isNumericSlotId && !isCanonicalSlotId) {
    sendErrorResponse(res, new BadRequestError("Invalid slot id"), req);
    return;
  }

  next();
}
