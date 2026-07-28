/**
 * Timezone Resolution Middleware
 *
 * Resolves the buyer's display timezone using the precedence chain:
 *   1. Buyer profile timezone (if authenticated)
 *   2. X-Timezone request header
 *   3. UTC fallback
 *
 * Attaches `req.buyerTimezone` and `req.buyerTimezoneSource` for downstream
 * handlers (slot listing, marketplace search) to consume.
 *
 * Security: malformed timezone values in the header are rejected with 400
 * to prevent injection of arbitrary strings into downstream formatting logic.
 */

import { Request, Response, NextFunction } from "express";
import {
  resolveTimezone,
  isValidIANATimezone,
  DEFAULT_TIMEZONE,
} from "../services/timezoneService.js";

declare module "express" {
  interface Request {
    /** Resolved IANA timezone for the current buyer. */
    buyerTimezone?: string;
    /** Source of the resolved timezone: "profile" | "header" | "default". */
    buyerTimezoneSource?: "profile" | "header" | "default";
  }
}

export const TIMEZONE_HEADER = "x-timezone";

/**
 * Express middleware that resolves the buyer's timezone and decorates the
 * request with `req.buyerTimezone` and `req.buyerTimezoneSource`.
 *
 * Usage:
 *   app.use("/api/v1/slots", resolveBuyerTimezone());
 *
 * The optional `getProfileTimezone` callback allows callers to look up
 * the buyer's profile timezone from their auth context (e.g. req.auth.userId).
 */
export function resolveBuyerTimezone(options?: {
  getProfileTimezone?: (req: Request) => string | null | undefined;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const headerTz = req.headers[TIMEZONE_HEADER] as string | undefined;

    // Validate header early: if present and malformed, reject with 400
    if (headerTz && headerTz.trim().length > 0 && !isValidIANATimezone(headerTz)) {
      res.status(400).json({
        success: false,
        error: "Invalid timezone",
      });
      return;
    }

    // Try profile timezone first
    let profileTz: string | null | undefined = undefined;
    if (options?.getProfileTimezone) {
      try {
        profileTz = options.getProfileTimezone(req);
      } catch {
        // Profile lookup failure is non-fatal; fall through to header/default
      }
    }

    const resolved = resolveTimezone(profileTz ?? null, headerTz ?? null);
    req.buyerTimezone = resolved;

    if (profileTz && isValidIANATimezone(profileTz)) {
      req.buyerTimezoneSource = "profile";
    } else if (headerTz && isValidIANATimezone(headerTz)) {
      req.buyerTimezoneSource = "header";
    } else {
      req.buyerTimezoneSource = "default";
    }

    next();
  };
}

export { DEFAULT_TIMEZONE };
