import type { NextFunction, Request, Response } from "express";
import { getRedisClient } from "../cache/redisClient.js";
import { generateRequestHash } from "../utils/hash.js";
import { getIdempotencyPayloadCodec } from "../utils/idempotencyPayloadCodec.js";
import { IdempotencyError } from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";
import { sendErrorResponse } from "../errors/sendError.js";

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
    // Fail closed: without Redis we cannot guarantee idempotency, so reject
    // rather than silently allowing duplicate processing.
    res.status(503).json({
      success: false,
      code: "DEPENDENCY_UNAVAILABLE",
      error: "Redis is currently unavailable",
    });
    return;
  }

  // --- Header validation: reject malformed keys before touching Redis ---
  const keyValidation = validateIdempotencyKey(idempotencyKey);
  if (!keyValidation.valid) {
    sendErrorResponse(
      res,
      new IdempotencyError(
        keyValidation.reason,
        ERROR_CODES.IDEMPOTENCY_KEY_INVALID.code,
      ),
      req,
    );
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
        sendErrorResponse(
          res,
          new IdempotencyError(
            "Conflict: This transaction is actively running.",
            ERROR_CODES.IDEMPOTENCY_IN_PROGRESS.code,
          ),
          req,
        );
        return;
      }

      if (parsedData.requestHash !== incomingHash) {
        sendErrorResponse(
          res,
          new IdempotencyError(
            "Unprocessable Entity: Idempotency-Key used with different payload.",
            ERROR_CODES.IDEMPOTENCY_KEY_MISMATCH.code,
          ),
          req,
        );
        return;
      }

      res.status(parsedData.statusCode).json(parsedData.responseBody);
      return;
    }

    const processingState: IdempotencyProcessingState = {
      status: "processing",
      requestMethod: req.method,
      requestPath: req.originalUrl,
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
      sendErrorResponse(
        res,
        new IdempotencyError(
          "Conflict: This transaction is actively running.",
          ERROR_CODES.IDEMPOTENCY_IN_PROGRESS.code,
        ),
        req,
      );
      return;
    }

    const originalJson = res.json.bind(res);

    res.json = ((body: unknown) => {
      const completedState: IdempotencyCompletedState = {
        status: "completed",
        requestMethod: req.method,
        requestPath: req.originalUrl,
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
