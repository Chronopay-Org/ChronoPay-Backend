import { Request, Response, NextFunction } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_HEADER = "x-webhook-signature";
const HMAC_ALGORITHM = "sha256";
const STALE_PAYLOAD_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const CLOCK_SKEW_MS = 60 * 1000; // 1 minute

function isValidHex(signature: string) {
  return /^[0-9a-fA-F]{64}$/.test(signature);
}

function getSignatureFromHeader(headerValue: string | undefined) {
  if (!headerValue) {
    return undefined;
  }

  const trimmed = headerValue.trim();
  if (trimmed.toLowerCase().startsWith(`${HMAC_ALGORITHM}=`)) {
    return trimmed.slice(HMAC_ALGORITHM.length + 1);
  }

  return trimmed;
}

function compareSignatures(expectedHex: string, actualHex: string) {
  if (!isValidHex(expectedHex) || !isValidHex(actualHex)) {
    return false;
  }

  const expectedBuffer = Buffer.from(expectedHex, "hex");
  const actualBuffer = Buffer.from(actualHex, "hex");

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function internalHmacAuth(expectedSecret?: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!expectedSecret) {
      return res.status(500).json({
        success: false,
        error: "Settlement webhook signing secret is not configured.",
      });
    }

    const signatureHeader = req.header(SIGNATURE_HEADER);
    const providedSignature = getSignatureFromHeader(signatureHeader);

    if (!providedSignature) {
      return res.status(401).json({
        success: false,
        error: "Missing webhook signature.",
      });
    }

    const rawBody = req.rawBody ?? Buffer.from("");
    const computedSignature = createHmac(HMAC_ALGORITHM, expectedSecret)
      .update(rawBody)
      .digest("hex");

    if (!compareSignatures(providedSignature, computedSignature)) {
      return res.status(403).json({
        success: false,
        error: "Invalid webhook signature.",
      });
    }

    next();
  };
}
