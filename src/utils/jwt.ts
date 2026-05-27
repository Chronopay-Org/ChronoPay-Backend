import jwt, { JwtPayload } from "jsonwebtoken";
import { getJwtConfig } from "../config/jwt.js";

export interface VerifiedJwtPayload extends JwtPayload {
  exp: number;
  iat: number;
  [key: string]: any;
}

export function verifyJwt(token: string): VerifiedJwtPayload {
  const config = getJwtConfig();
  try {
    const decoded = jwt.verify(token, config.secret, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: config.algorithms,
      clockTolerance: config.leewaySeconds,
    }) as JwtPayload;

    // Audience shape validation
    const aud = decoded.aud;
    if (aud !== undefined) {
      if (typeof aud !== "string" && !Array.isArray(aud)) {
        throw new Error("Invalid audience shape: must be string or array of strings");
      }
      if (Array.isArray(aud) && !aud.every(a => typeof a === "string")) {
        throw new Error("Invalid audience shape: array must contain only strings");
      }
    }

    if (typeof decoded.exp !== "number" || typeof decoded.iat !== "number") {
      throw new Error("Token missing required numeric exp or iat claims");
    }

    const now = Math.floor(Date.now() / 1000);
    if (decoded.iat > now + config.leewaySeconds) {
      throw new Error("Token iat is too far in the future");
    }

    return decoded as VerifiedJwtPayload;
  } catch (error) {
    throw new Error("INVALID_TOKEN");
  }
}
