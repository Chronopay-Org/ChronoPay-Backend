import { Request, Response, NextFunction } from "express";
import {
  BadRequestError,
  InternalServerError,
  MissingRequiredFieldError,
} from "../errors/AppError.js";
import { sendErrorResponse } from "../errors/sendError.js";

type ValidationTarget = "body" | "query" | "params";

export function validateRequiredFields(
  requiredFields: string[],
  target: ValidationTarget = "body",
) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = req[target];

      if (!data || typeof data !== "object") {
        return sendErrorResponse(
          res,
          new BadRequestError(`Request ${target} is missing or invalid`),
          req,
        );
      }

      for (const field of requiredFields) {
        const value = data[field];

        if (value === undefined || value === null || value === "") {
          return sendErrorResponse(res, new MissingRequiredFieldError(field), req);
        }
      }

      next();
    } catch {
      return sendErrorResponse(
        res,
        new InternalServerError("Validation middleware error"),
        req,
      );
    }
  };
}
