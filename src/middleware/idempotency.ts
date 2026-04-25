import type { NextFunction, Request, Response } from "express";
import { getRedisClient } from "../cache/redisClient.js";
import { generateRequestHash } from "../utils/hash.js";
import { getIdempotencyPayloadCodec } from "../utils/idempotencyPayloadCodec.js";

const IDEMPOTENCY_EXPIRATION_SECONDS = 86400;

interface IdempotencyProcessingState {
  status: "processing";
  requestHash: string;
}

interface IdempotencyCompletedState {
  status: "completed";
  requestHash: string;
  statusCode: number;
  responseBody: unknown;
}

type IdempotencyState = IdempotencyProcessingState | IdempotencyCompletedState;

export const idempotencyMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const idempotencyKey = req.header("Idempotency-Key");

  if (!idempotencyKey) {
    next();
    return;
  }

  const redis = getRedisClient();
  if (!redis) {
    next();
    return;
  }

  try {
    const storageKey = `idempotency:req:${idempotencyKey}`;
    const incomingHash = generateRequestHash(req.method, req.originalUrl, req.body);
    const codec = getIdempotencyPayloadCodec();
    const existingData = await redis.get(storageKey);

    if (existingData) {
      const parsedData = codec.deserialize<IdempotencyState>(existingData);

      if (parsedData.status === "processing") {
        res.status(409).json({
          success: false,
          error: "Conflict: This transaction is actively running.",
        });
        return;
      }

      if (parsedData.requestHash !== incomingHash) {
        res.status(422).json({
          success: false,
          error: "Unprocessable Entity: Idempotency-Key used with different payload.",
        });
        return;
      }

      res.status(parsedData.statusCode).json(parsedData.responseBody);
      return;
    }

    const processingState: IdempotencyProcessingState = {
      status: "processing",
      requestHash: incomingHash,
    };

    const lockAcquired = await redis.set(
      storageKey,
      codec.serialize(processingState),
      "EX",
      IDEMPOTENCY_EXPIRATION_SECONDS,
      "NX",
    );

    if (lockAcquired !== "OK") {
      res.status(409).json({
        success: false,
        error: "Conflict: This transaction is actively running.",
      });
      return;
    }

    const originalJson = res.json.bind(res);

    res.json = ((body: unknown) => {
      const completedState: IdempotencyCompletedState = {
        status: "completed",
        requestHash: incomingHash,
        statusCode: res.statusCode,
        responseBody: body,
      };

      redis
        .set(
          storageKey,
          codec.serialize(completedState),
          "EX",
          IDEMPOTENCY_EXPIRATION_SECONDS,
        )
        .catch((error: Error) => {
          console.error("Failed to persist idempotency response:", error.message);
        });

      return originalJson(body);
    }) as Response["json"];

    next();
  } catch (error) {
    next(error);
  }
};
