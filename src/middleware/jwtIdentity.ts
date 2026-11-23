import type { Request } from "express";
import { configService } from "../config/config.service.js";
import { verifyJwt, type VerifiedJwtPayload } from "../utils/jwt.js";

export class MissingBearerTokenError extends Error {
  constructor() {
    super("Missing Authorization header");
    this.name = "MissingBearerTokenError";
  }
}

export function readBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export function getUserId(claims: VerifiedJwtPayload): string {
  const candidate = claims.sub ?? claims.id;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : "";
}

export async function verifyRequestJwt(
  req: Request,
  expectedIssuer?: string,
): Promise<VerifiedJwtPayload> {
  const token = readBearerToken(req);
  if (!token) {
    throw new MissingBearerTokenError();
  }

  return verifyJwt(token, {
    issuer: expectedIssuer ?? configService.jwtIssuer ?? undefined,
  });
}
