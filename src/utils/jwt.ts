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
      const { payload: decoded } = await jwtVerify(token, encoder.encode(secret), verifyOptions);

      // Audience shape validation
      const aud = decoded.aud;
      if (aud !== undefined) {
        if (typeof aud !== "string" && !Array.isArray(aud)) {
          throw new Error("Invalid audience shape: must be string or array of strings");
        }
        if (Array.isArray(aud) && !aud.every((a) => typeof a === "string")) {
          throw new Error("Invalid audience shape: array must contain only strings");
        }
      }

      if (typeof decoded.exp !== "number" || typeof decoded.iat !== "number") {
        throw new Error("Token missing required numeric exp or iat claims");
      }

      const now = Math.floor(Date.now() / 1000);
      if (decoded.iat > now + 300) {
        throw new Error("Token iat is too far in the future");
      }

      return decoded as VerifiedJwtPayload;
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
