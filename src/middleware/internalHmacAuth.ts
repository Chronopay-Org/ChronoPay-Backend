import { Request, Response, NextFunction } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { webhookHmacVerified } from "../metrics.js";

const SIGNATURE_HEADER = "x-webhook-signature";
const HMAC_ALGORITHM = "sha256";
// eslint-disable-next-line unused-imports/no-unused-vars
const STALE_PAYLOAD_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
// eslint-disable-next-line unused-imports/no-unused-vars
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
    const currentSecret = expectedSecret ?? process.env.SETTLEMENTS_WEBHOOK_SECRET;
    const previousSecret = process.env.SETTLEMENTS_WEBHOOK_SECRET_PREVIOUS;

    if (!currentSecret) {
      return res.status(500).json({
        success: false,
        error: "Settlement webhook signing secret is not configured.",
      });
    }

    const signatureHeader = req.header(SIGNATURE_HEADER);
    const providedSignature = getSignatureFromHeader(signatureHeader);

    if (!providedSignature) {
      webhookHmacVerified.labels("missing").inc();
      return res.status(401).json({
        success: false,
        error: "Missing webhook signature.",
      });
    }

    const rawBody = req.rawBody ?? Buffer.from("");

    const computeHex = (secret: string) =>
      createHmac(HMAC_ALGORITHM, secret).update(rawBody).digest("hex");

    const currentHex = computeHex(currentSecret);
    if (compareSignatures(providedSignature, currentHex)) {
      webhookHmacVerified.labels("current").inc();
      return next();
    }

    if (previousSecret) {
      const prevHex = computeHex(previousSecret);
      if (compareSignatures(providedSignature, prevHex)) {
        webhookHmacVerified.labels("previous").inc();
        return next();
      }
    }

    webhookHmacVerified.labels("invalid").inc();
    return res.status(403).json({
      success: false,
      error: "Invalid webhook signature.",
    });
  };
}
