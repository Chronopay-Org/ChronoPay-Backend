import { Request, Response, NextFunction } from "express";
import {
  BadRequestError,
  InternalServerError,
  MissingRequiredFieldError,
} from "../errors/AppError.js";
import { sendErrorResponse } from "../errors/sendError.js";

type ValidationTarget = "body" | "query" | "params";

/**
 * A single validation failure.
 *
 * - `path`    field name exactly as supplied (e.g. "startTime")
 * - `rule`    machine-readable rule identifier (e.g. "required")
 * - `message` human-readable description — never contains the raw value
 */
export interface ValidationDetail {
  path: string;
  rule: string;
  message: string;
}

/**
 * The envelope returned by all validation middleware on failure.
 *
 * `code`    is a stable, machine-readable string clients can switch on.
 * `details` is sorted by (path ASC, rule ASC) so order is deterministic.
 */
export interface ValidationErrorResponse {
  success: false;
  code: string;
  error: string;
  details: ValidationDetail[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Sort validation details deterministically: primary key = path, secondary = rule.
 * Sorting is lexicographic and locale-independent (localeCompare is intentionally
 * avoided to guarantee identical output across Node.js versions and locales).
 */
function sortDetails(details: ValidationDetail[]): ValidationDetail[] {
  return [...details].sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    if (a.rule < b.rule) return -1;
    if (a.rule > b.rule) return 1;
    return 0;
  });
}

/**
 * Build a deterministic 400 response.
 * This is the only place the response shape is constructed so the format
 * stays consistent across all validators.
 */
function buildValidationError(
  res: Response,
  details: ValidationDetail[],
): Response {
  const sorted = sortDetails(details);
  const body: ValidationErrorResponse = {
    success: false,
    code: "VALIDATION_ERROR",
    error: "One or more fields failed validation",
    details: sorted,
  };
  return res.status(400).json(body);
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Validates that every field in `requiredFields` is present and non-empty
 * in `req[target]`.
 *
 * Unlike the previous implementation this middleware collects ALL failing
 * fields before responding, and returns them sorted by (path, rule) so
 * the order is deterministic across calls.
 *
 * Security notes:
 * - Raw field values are never included in the response.
 * - Messages identify the field name only; the field name comes from the
 *   caller-supplied `requiredFields` array, not from user input.
 *
 * @param requiredFields  List of field names that must be present.
 * @param target          Which part of the request to inspect (default: "body").
 */
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

      // Collect every failing field instead of short-circuiting
      const details: ValidationDetail[] = [];

      for (const field of requiredFields) {
        const value = (data as Record<string, unknown>)[field];

        if (value === undefined || value === null || value === "") {
          return sendErrorResponse(res, new MissingRequiredFieldError(field), req);
        }
      }

      if (details.length > 0) {
        return buildValidationError(res, details);
      }

      return next();
    } catch {
      return sendErrorResponse(
        res,
        new InternalServerError("Validation middleware error"),
        req,
      );
    }
  };
}
