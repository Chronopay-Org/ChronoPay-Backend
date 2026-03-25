import { Request, Response, NextFunction } from "express";

type ValidationTarget = "body" | "query" | "params";

export function validateRequiredFields(
  requiredFields: string[],
  target: ValidationTarget = "body",
) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = req[target];

      if (!data || typeof data !== "object") {
        return res.status(400).json({
          success: false,
          error: `Request ${target} is missing or invalid`,
        });
      }

      for (const field of requiredFields) {
        const value = data[field];

        if (value === undefined || value === null || value === "") {
          return res.status(400).json({
            success: false,
            error: `Missing required field: ${field}`,
          });
        }
      }

      next();
    } catch {
      return res.status(500).json({
        success: false,
        error: "Validation middleware error",
      });
    }
  };
}