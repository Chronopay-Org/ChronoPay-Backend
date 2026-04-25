import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getRedisClient } from "../utils/redis.js";

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
      return res.status(401).json({
        success: false,
        error: "Missing internal authentication headers",
      });
    }

    const timestampMs = Number(timestampHeader);
    if (!Number.isFinite(timestampMs)) {
      return res.status(401).json({
        success: false,
        error: "Invalid internal timestamp",
      });
    }

    const ageSeconds = Math.abs(Date.now() - timestampMs) / 1000;
    if (ageSeconds > maxSkewSeconds) {
      return res.status(401).json({
        success: false,
        error: "Internal request timestamp outside allowed skew window",
      });
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
      return res.status(401).json({
        success: false,
        error: "Invalid internal request signature",
      });
    }

    const replayKey = `${timestampHeader}:${signatureHeader}`;
    const isReplay = await detectReplay(replayKey, replayTtlSeconds);
    if (isReplay) {
      return res.status(409).json({
        success: false,
        error: "Replay detected for internal request",
      });
    }

    next();
  };
}

export const INTERNAL_HMAC_HEADERS = {
  TIMESTAMP_HEADER,
  SIGNATURE_HEADER,
};
