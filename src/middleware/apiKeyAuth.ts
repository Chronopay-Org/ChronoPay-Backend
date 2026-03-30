import { Request, Response, NextFunction } from "express";

const API_KEY_HEADER = "x-api-key";

export function requireApiKey(expectedApiKey?: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!expectedApiKey) {
      return next();
    }

    const provided = req.header(API_KEY_HEADER);

    if (!provided) {
      return res.status(401).json({
        success: false,
        error: "Missing API key",
      });
    }

    if (provided !== expectedApiKey) {
      return res.status(403).json({
        success: false,
        error: "Invalid API key",
      });
    }

    next();
  };
}
