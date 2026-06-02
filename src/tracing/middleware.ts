import { Request, Response, NextFunction } from "express";
import {
  generateId,
  runWithTraceContext,
  getTraceContext,
  TraceContext,
  parseTraceparent,
  formatTraceparent,
} from "./context.js";

/**
 * Standard HTTP header keys for distributed tracing.
 * Follows industry conventions (e.g., Zipkin, B3).
 */
export const TRACE_HEADERS = {
  TRACE_ID: "x-trace-id",
  SPAN_ID: "x-span-id",
  PARENT_SPAN_ID: "x-parent-span-id",
  TRACEPARENT: "traceparent",
};

/**
 * Express middleware to initialize distributed tracing for incoming requests.
 * Supports both W3C traceparent and custom trace headers.
 * Extracts tracing info from headers or generates new identifiers if missing.
 * Sets trace headers in response for traceability.
 */
export function tracingMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  let context: TraceContext;

  // Try to parse W3C traceparent header first
  const traceparentHeader = req.headers[TRACE_HEADERS.TRACEPARENT] as string;
  const parsedTraceparent = traceparentHeader ? parseTraceparent(traceparentHeader) : undefined;

  if (parsedTraceparent) {
    // Use W3C traceparent context but generate a new span ID for this request
    const spanId = generateId().replace(/-/g, "").substring(0, 16);
    context = {
      traceId: parsedTraceparent.traceId!,
      spanId,
      parentSpanId: parsedTraceparent.parentSpanId,
      traceFlags: parsedTraceparent.traceFlags || "01",
      startTime: Date.now(),
    };
  } else {
    // Fall back to custom headers or generate new
    const traceId =
      (req.headers[TRACE_HEADERS.TRACE_ID] as string) ||
      generateId().replace(/-/g, "").substring(0, 32);
    const parentSpanId = req.headers[TRACE_HEADERS.PARENT_SPAN_ID] as string;
    const spanId = generateId().replace(/-/g, "").substring(0, 16);

    context = {
      traceId: traceId.substring(0, 32), // Ensure 32 chars
      spanId,
      parentSpanId: parentSpanId?.substring(0, 16), // Ensure 16 chars if present
      traceFlags: "01",
      startTime: Date.now(),
    };
  }

  // Set response headers for traceability (W3C + custom for compatibility)
  res.setHeader(TRACE_HEADERS.TRACEPARENT, formatTraceparent(context));
  res.setHeader(TRACE_HEADERS.TRACE_ID, context.traceId);
  res.setHeader(TRACE_HEADERS.SPAN_ID, context.spanId);

  // Wrap subsequent execution in the tracing context
  runWithTraceContext(context, () => {
    next();
  });
}

/**
 * Utility function to get current trace headers for outgoing requests.
 * Emits both W3C traceparent and custom headers for compatibility.
 */
export function getPropagationHeaders(): Record<string, string> {
  const context = getTraceContext();
  if (!context) {
    return {};
  }

  return {
    [TRACE_HEADERS.TRACEPARENT]: formatTraceparent(context),
    [TRACE_HEADERS.TRACE_ID]: context.traceId,
    [TRACE_HEADERS.PARENT_SPAN_ID]: context.spanId,
  };
}
