import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * Interface representing the tracing context.
 * This structure holds trace-related metadata for distributed tracing.
 */
export interface TraceContext {
  /** Global identifier for the entire request path across services (32 hex chars) */
  traceId: string;
  /** Identifier for the current unit of work (span) (16 hex chars) */
  spanId: string;
  /** Identifier for the parent span, if any (16 hex chars) */
  parentSpanId?: string;
  /** Timestamp when the span started */
  startTime: number;
  /** W3C trace flags (2 hex chars, typically "01" for sampled) */
  traceFlags: string;
}

/**
 * Global storage for tracing context, leveraging Node.js AsyncLocalStorage.
 * This allows us to access the current trace context anywhere in the call stack
 * without explicit parameter passing.
 */
const tracingStorage = new AsyncLocalStorage<TraceContext>();

/**
 * Generate a W3C compliant trace ID (32 hex chars).
 */
function generateW3cTraceId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Generate a W3C compliant span ID (16 hex chars).
 */
function generateW3cSpanId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Parse W3C traceparent header format: "version-trace_id-parent_span_id-trace_flags"
 * Returns parsed context or undefined if invalid.
 */
export function parseTraceparent(
  traceparent: string,
): Partial<TraceContext> | undefined {
  if (!traceparent || typeof traceparent !== "string") {
    return undefined;
  }

  const parts = traceparent.split("-");
  if (parts.length !== 4) {
    return undefined;
  }

  const [version, traceId, parentSpanId, traceFlags] = parts;

  // Version must be "00"
  if (version !== "00") {
    return undefined;
  }

  // Validate hex formats
  if (
    !/^[0-9a-f]{32}$/i.test(traceId) ||
    !/^[0-9a-f]{16}$/i.test(parentSpanId) ||
    !/^[0-9a-f]{2}$/i.test(traceFlags)
  ) {
    return undefined;
  }

  return {
    traceId: traceId.toLowerCase(),
    parentSpanId: parentSpanId.toLowerCase(),
    traceFlags: traceFlags.toLowerCase(),
  };
}

/**
 * Format tracing context as W3C traceparent header.
 */
export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId.toLowerCase()}-${context.spanId.toLowerCase()}-${(context.traceFlags || "01").toLowerCase()}`;
}

/**
 * Retrieves the current tracing context if available.
 * @returns The current TraceContext or undefined if not in a tracing scope.
 */
export function getTraceContext(): TraceContext | undefined {
  return tracingStorage.getStore();
}

/**
 * Runs a function within a new tracing context.
 * @param context - The TraceContext to associate with this execution scope.
 * @param fn - The function to execute.
 * @returns The result of the function execution.
 */
export function runWithTraceContext<T>(context: TraceContext, fn: () => T): T {
  return tracingStorage.run(context, fn);
}

/**
 * Generates a new unique trace identifier (UUID v4).
 * Uses standard UUID v4 for backward compatibility.
 */
export function generateId(): string {
  const bytes = randomBytes(16);
  // UUID v4 format with version and variant bits
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Creates a new child trace context from the current or a given context.
 * Useful for instrumentation of sub-tasks or internal operations.
 */
export function createChildContext(
  parentContext?: TraceContext,
): TraceContext {
  const current = parentContext || getTraceContext();
  return {
    traceId: current?.traceId || generateW3cTraceId(),
    spanId: generateW3cSpanId(),
    parentSpanId: current?.spanId,
    traceFlags: current?.traceFlags || "01",
    startTime: Date.now(),
  };
}
