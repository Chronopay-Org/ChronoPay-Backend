/**
 * rejectRevokedKey middleware
 *
 * Rejects any request that presents a signing key ID that has been revoked.
 * The key ID is expected in the `x-signing-key-id` request header.
 *
 * Behaviour
 * ─────────
 * - If the header is absent the middleware passes through (other middleware
 *   handles missing-auth cases).
 * - If the header is present and the key is revoked, responds 401 with a
 *   structured error payload.
 * - If the header is present and the key is NOT revoked, calls next().
 *
 * Usage
 * ─────
 * ```ts
 * import { revocationService } from "../services/revocationService.js";
 * import { rejectRevokedKey }   from "../middleware/rejectRevokedKey.js";
 *
 * router.use(rejectRevokedKey(revocationService));
 * ```
 *
 * The header name is `x-signing-key-id` (lowercase, per Express convention).
 */

import type { Request, Response, NextFunction } from "express";
import type { RevocationService } from "../services/revocationService.js";

export const SIGNING_KEY_HEADER = "x-signing-key-id";

/**
 * Returns an Express middleware that rejects requests presenting a revoked
 * signing key ID.
 *
 * @param revocationService  A started RevocationService instance.
 */
export function rejectRevokedKey(revocationService: RevocationService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const keyId = req.headers[SIGNING_KEY_HEADER];

    // Header absent — not our concern; let auth middleware handle it.
    if (!keyId) {
      next();
      return;
    }

    const id = Array.isArray(keyId) ? keyId[0] : keyId;

    if (revocationService.isRevoked(id)) {
      res.status(401).json({
        success: false,
        code: "KEY_REVOKED",
        error: "The signing key presented has been revoked.",
      });
      return;
    }

    next();
  };
}
