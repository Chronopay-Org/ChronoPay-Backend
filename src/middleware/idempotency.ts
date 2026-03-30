import { Request, Response, NextFunction } from "express";
import { getRedisClient } from "../utils/redis.js";
import { generateRequestHash } from "../utils/hash.js";

const IDEMPOTENCY_EXPIRATION = 86400; // 24 hours

export const idempotencyMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const idempotencyKey = req.header("Idempotency-Key");

  if (!idempotencyKey) {
    // Proceed normally if no key is provided (Opt-in mode)
    return next();
  }

  try {
    const redis = getRedisClient();
    const storageKey = `idempotency:req:${idempotencyKey}`;
    const incomingHash = generateRequestHash(req.method, req.originalUrl, req.body);

    const existingData = await redis.get(storageKey);

    if (existingData) {
      const parsedData = JSON.parse(existingData);

      // Concurrent request check
      if (parsedData.status === "processing") {
        res.status(409).json({
          success: false,
          error: "Conflict: This transaction is actively running.",
        });
        return;
      }

      // Payload mismatch check
      if (parsedData.requestHash !== incomingHash) {
        res.status(422).json({
          success: false,
          error: "Unprocessable Entity: Idempotency-Key used with different payload.",
        });
        return;
      }

      // Duplicate request (Happy Path): Serve cached result
      if (parsedData.status === "completed") {
        res.status(parsedData.statusCode).json(parsedData.responseBody);
        return;
      }
    }

    // Cache Miss: Safely attempt to claim the atomic lock using NX (Not Exists)
    const processingState = {
      status: "processing",
      requestHash: incomingHash,
    };
    
    const lockAcquired = await redis.set(
      storageKey, 
      JSON.stringify(processingState), 
      "EX", 
      IDEMPOTENCY_EXPIRATION, 
      "NX"
    );

    if (lockAcquired !== "OK") {
      // Race Condition caught - another duplicate snagged the lock in the same millisecond!
      res.status(409).json({
        success: false,
        error: "Conflict: This transaction is actively running.",
      });
      return;
    }

    // Attach hook natively into Express res.json method
    const originalJson = res.json.bind(res);

    res.json = (body: any) => {
      // Lock in final resolved response values and write passively
      const completedState = {
        status: "completed",
        requestHash: incomingHash,
        statusCode: res.statusCode,
        responseBody: body,
      };

      redis.set(storageKey, JSON.stringify(completedState), "EX", IDEMPOTENCY_EXPIRATION).catch((err: Error) => {
        console.error("Failed to safely commit final idempotency state:", err.message);
      });

      // Stream original data out
      return originalJson(body);
    };

    next();
  } catch (err) {
    // Kick complex infrastructure failures to the main global ErrorHandler safely
    next(err);
  }
};
