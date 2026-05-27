import { Router, Request, Response } from "express";
import { configService } from "../config/config.service.js";
import { verifyJwt } from "../utils/jwt.js";

const router = Router();

/**
 * POST /api/v1/auth/verify
 * Verifies a JWT against all active secret versions and returns the verified claims.
 */
router.post("/verify", async (req: Request, res: Response) => {
  const { token } = req.body ?? {};

  if (!token || typeof token !== "string") {
    return res.status(400).json({ success: false, error: "token is required" });
  }

  try {
    const payload = await verifyJwt(token, { issuer: configService.jwtIssuer ?? undefined });

    return res.status(200).json({
      success: true,
      actor: {
        sub: payload.sub ?? payload.id ?? null,
        role: payload.role ?? null,
        iss: payload.iss ?? null,
        exp: payload.exp,
      },
    });
  } catch {
    return res.status(401).json({ success: false, error: "Invalid token" });
  }
});

export default router;