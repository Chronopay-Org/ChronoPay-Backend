import { Request, Response, NextFunction } from "express";
import { slotService, SlotNotFoundError } from "../services/slotService.js";

const SLOT_NOT_FOUND = "Slot not found";

export type SlotDeleteAuth =
  | { mode: "chronopay"; userId: string; role: string }
  | { mode: "legacy"; userId: string };

declare global {
  namespace Express {
    interface Request {
      slotDeleteAuth?: SlotDeleteAuth;
    }
  }
}

/**
 * DELETE /api/v1/slots/:id — supports x-chronopay-* (403 for non-owner) and x-user-id/x-role (404 for non-owner).
 */
export function authorizeSlotDelete(req: Request, res: Response, next: NextFunction): void {
  const chronopayUserId = req.header("x-chronopay-user-id");
  const chronopayRole = req.header("x-chronopay-role");
  const legacyUserId = req.header("x-user-id");
  const legacyRole = req.header("x-role");

  const useChronopay = chronopayUserId !== undefined || chronopayRole !== undefined;
  const useLegacy = legacyUserId !== undefined || legacyRole !== undefined;

  if (!useChronopay && !useLegacy) {
    res.status(401).json({ success: false, error: "Authentication required." });
    return;
  }

  if (useChronopay) {
    if (!chronopayUserId) {
      res.status(401).json({ success: false, error: "Authentication required." });
      return;
    }
    if (chronopayRole === "admin") {
      next();
      return;
    }
    req.slotDeleteAuth = {
      mode: "chronopay",
      userId: chronopayUserId,
      role: chronopayRole ?? "customer",
    };
    next();
    return;
  }

  if (legacyRole === "admin") {
    next();
    return;
  }

  if (!legacyUserId) {
    res.status(401).json({ success: false, error: "Authentication required" });
    return;
  }

  req.slotDeleteAuth = { mode: "legacy", userId: legacyUserId };
  next();
}

export async function assertSlotDeleteAllowed(
  req: Request,
  res: Response,
  slotId: string,
): Promise<boolean> {
  const auth = req.slotDeleteAuth;
  if (!auth) {
    return true;
  }

  let slot;
  try {
    slot = await slotService.findById(slotId);
  } catch (error) {
    if (error instanceof SlotNotFoundError) {
      res.status(404).json({ success: false, error: SLOT_NOT_FOUND });
      return false;
    }
    throw error;
  }

  if (auth.mode === "chronopay" && slot.professional !== auth.userId) {
    res.status(403).json({ success: false, error: "Insufficient permissions" });
    return false;
  }

  if (auth.mode === "legacy" && slot.professional !== auth.userId) {
    res.status(404).json({ success: false, error: SLOT_NOT_FOUND });
    return false;
  }

  return true;
}
