import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { configService } from "../config/config.service.js";

export interface VerifiedJwtPayload extends JWTPayload {
  sub?: string;
  role?: string;
  email?: string;
  id?: string;
  iat?: number;
  exp: number;
}

export async function verifyJwt(token: string, options?: { issuer?: string; audience?: string }) {
  const secrets = configService.getAllSecretVersions("JWT_SECRET");
  const encoder = new TextEncoder();

  const verifyOptions: { issuer?: string; audience?: string } = {};
  if (options?.issuer ?? configService.jwtIssuer) {
    verifyOptions.issuer = options?.issuer ?? configService.jwtIssuer;
  }
  if (options?.audience ?? configService.jwtAudience) {
    verifyOptions.audience = options?.audience ?? configService.jwtAudience;
  }

  for (const secret of secrets) {
    try {
      const { payload } = await jwtVerify(token, encoder.encode(secret), verifyOptions);
      if (typeof payload.exp !== "number") {
        throw new Error("Token missing exp claim");
      }

      return payload as VerifiedJwtPayload;
    } catch {
      // try next secret
    }
  }

  throw new Error("INVALID_TOKEN");
}

export async function signJwt(
  payload: JWTPayload,
  secret: string,
  options?: { expiresInSec?: number; issuer?: string; audience?: string },
) {
  const encoder = new TextEncoder();
  let jwt = new SignJWT(payload).setProtectedHeader({ alg: "HS256" });

  if (options?.issuer) {
    jwt = jwt.setIssuer(options.issuer);
  }

  if (options?.audience) {
    jwt = jwt.setAudience(options.audience);
  }

  if (options?.expiresInSec !== undefined) {
    jwt = jwt.setExpirationTime(Math.floor(Date.now() / 1000) + options.expiresInSec);
  }

  return jwt.sign(encoder.encode(secret));
}
