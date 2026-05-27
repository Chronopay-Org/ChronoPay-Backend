import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getRedisClient } from "../utils/redis.js";
import { ConflictError, UnauthorizedError } from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";
import { sendErrorResponse } from "../errors/sendError.js";

const TIMESTAMP_HEADER = "x-chronopay-timestamp";
const SIGNATURE_HEADER = "x-chronopay-signature";
const REPLAY_PREFIX = "internal:hmac:replay";

const memoryReplayCache = new Map<string, number>();

export interface InternalHmacOptions {
  secret?: string;
  maxSkewSeconds?: number;
  replayTtlSeconds?: number;
}

function safeEqualHex(expectedHex: string, receivedHex: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const received = Buffer.from(receivedHex, "hex");
  if (expected.length !== received.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, received);
}

function createBodyHash(body: unknown): string {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function pruneReplayCache(now: number): void {
  for (const [key, expiry] of memoryReplayCache.entries()) {
    if (expiry <= now) {
      memoryReplayCache.delete(key);
    }
  }
}

async function detectReplay(
  key: string,
  ttlSeconds: number,
): Promise<boolean> {
  try {
    const redis = getRedisClient();
    if (redis) {
      const redisKey = `${REPLAY_PREFIX}:${key}`;
      const result = await redis.set(redisKey, "1", "EX", ttlSeconds, "NX");
      return result !== "OK";
    }
  } catch {
    // Graceful fallback to in-memory replay cache if Redis is unavailable.
  }

  const now = Date.now();
  pruneReplayCache(now);
  if (memoryReplayCache.has(key)) {
    return true;
  }
  memoryReplayCache.set(key, now + ttlSeconds * 1000);
  return false;
}

export function requireInternalHmacAuth(options: InternalHmacOptions = {}) {
  const secret = options.secret ?? process.env.INTERNAL_HMAC_SECRET;
  const maxSkewSeconds = options.maxSkewSeconds ?? 300;
  const replayTtlSeconds = options.replayTtlSeconds ?? maxSkewSeconds;

  return async (req: Request, res: Response, next: NextFunction) => {
    if (!secret) {
      return next();
    }

    const timestampHeader = req.header(TIMESTAMP_HEADER);
    const signatureHeader = req.header(SIGNATURE_HEADER);

    if (!timestampHeader || !signatureHeader) {
      return sendErrorResponse(
        res,
        new UnauthorizedError(
          "Missing internal authentication headers",
          ERROR_CODES.AUTHENTICATION_REQUIRED.code,
        ),
        req,
      );
    }

    const timestampMs = Number(timestampHeader);
    if (!Number.isFinite(timestampMs)) {
      return sendErrorResponse(
        res,
        new UnauthorizedError(
          "Invalid internal timestamp",
          ERROR_CODES.INVALID_TIMESTAMP.code,
        ),
        req,
      );
    }

    const ageSeconds = Math.abs(Date.now() - timestampMs) / 1000;
    if (ageSeconds > maxSkewSeconds) {
      return sendErrorResponse(
        res,
        new UnauthorizedError(
          "Internal request timestamp outside allowed skew window",
          ERROR_CODES.TIMESTAMP_OUT_OF_SKEW.code,
        ),
        req,
      );
    }

    const method = req.method.toUpperCase();
    const path = req.originalUrl.split("?")[0];
    const bodyHash = createBodyHash(req.body);
    const message = `${timestampHeader}.${method}.${path}.${bodyHash}`;
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(message)
      .digest("hex");

    if (!safeEqualHex(expectedSignature, signatureHeader)) {
      return sendErrorResponse(
        res,
        new UnauthorizedError(
          "Invalid internal request signature",
          ERROR_CODES.INVALID_SIGNATURE.code,
        ),
        req,
      );
    }

    const replayKey = `${timestampHeader}:${signatureHeader}`;
    const isReplay = await detectReplay(replayKey, replayTtlSeconds);
    if (isReplay) {
      return sendErrorResponse(
        res,
        new ConflictError(
          "Replay detected for internal request",
          ERROR_CODES.REPLAY_DETECTED.code,
        ),
        req,
      );
    }

    next();
  };
}

export const INTERNAL_HMAC_HEADERS = {
  TIMESTAMP_HEADER,
  SIGNATURE_HEADER,
};
