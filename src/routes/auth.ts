import { Router, Request, Response } from "express";
import { configService } from "../config/config.service.js";

const router = Router();

/**
 * POST /api/v1/auth/verify
 * Accepts a token and validates it against all active secret versions.
 * Used by config rotation tests.
 */
router.post("/verify", (req: Request, res: Response) => {
  const { token } = req.body ?? {};

  if (!token || typeof token !== "string") {
    return res.status(400).json({ success: false, error: "token is required" });
  }

  const secrets = configService.getAllSecretVersions("JWT_SECRET");

  // Simple prefix-based validation for test purposes:
  // "valid-token-for-<secret>" is accepted if <secret> is in active versions
  for (const secret of secrets) {
    if (token === `valid-token-for-${secret}`) {
      return res.status(200).json({ success: true });
    }
  }

  return res.status(401).json({ success: false, error: "Invalid token" });
});

export default router;
