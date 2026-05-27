import { Request, Response, NextFunction } from "express";
import {
  generateId,
  runWithTraceContext,
  getTraceContext,
  TraceContext,
} from "./context.js";

/**
 * Standard HTTP header keys for distributed tracing.
 * Follows industry conventions (e.g., Zipkin, B3).
 */
export const TRACE_HEADERS = {
  TRACE_ID: "x-trace-id",
  SPAN_ID: "x-span-id",
  PARENT_SPAN_ID: "x-parent-span-id",
};

/**
 * Express middleware to initialize distributed tracing for incoming requests.
 * Extracts tracing info from headers or generates new identifiers if missing.
 * Sets the trace-id in response headers for traceability.
 */
export function tracingMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // Extract or generate trace ID
  const traceId = (req.headers[TRACE_HEADERS.TRACE_ID] as string) || generateId();
  const parentSpanId = req.headers[TRACE_HEADERS.PARENT_SPAN_ID] as string;
  const spanId = generateId();

  const context: TraceContext = {
    traceId,
    spanId,
    parentSpanId,
    startTime: Date.now(),
  };

  // Always return the trace ID to the client
  res.setHeader(TRACE_HEADERS.TRACE_ID, traceId);
  res.setHeader(TRACE_HEADERS.SPAN_ID, spanId);

  // Wrap subsequent execution in the tracing context
  runWithTraceContext(context, () => {
    next();
  });
}

/**
 * Utility function to get current trace headers for outgoing requests.
 * Useful for propagating trace context to other services.
 */
export function getPropagationHeaders(): Record<string, string> {
  const context = getTraceContext();
  return {
    [TRACE_HEADERS.TRACE_ID]: context?.traceId || "",
    [TRACE_HEADERS.PARENT_SPAN_ID]: context?.spanId || "",
  };
}
