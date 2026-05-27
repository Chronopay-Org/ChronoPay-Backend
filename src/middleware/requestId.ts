import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9\-_.]{7,127}$/;

function generateRequestId(): string {
  return `req_${crypto.randomUUID()}`;
}

export function resolveRequestId(candidate: unknown): string {
  if (typeof candidate !== "string") {
    return generateRequestId();
  }
  const normalized = candidate.trim();
  if (!REQUEST_ID_PATTERN.test(normalized)) {
    return generateRequestId();
  }
  return normalized;
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const requestId = resolveRequestId(req.header(REQUEST_ID_HEADER));
  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}
