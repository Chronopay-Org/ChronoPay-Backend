import { createChildContext, runWithTraceContext, getTraceContext } from "./context.js";
import { emitSpan } from "./spanExporter.js";

/**
 * Interface representing a tracing span.
 * Spans represent a single operation within a trace.
 */
export interface Span {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  /** Stable, non-PII attributes: route, requestId, outcome, latency, error */
  attributes: Record<string, string | number | boolean>;
}

/**
 * Wraps a synchronous or asynchronous function in a new child span.
 *
 * Stable attributes automatically recorded:
 *   - outcome: "ok" | "error"
 *   - latency: duration in ms (alias for duration)
 *   - error: true (only on failure)
 *   - error.message: sanitised message (only on failure)
 *
 * @param name       Span name, e.g. "slots.create"
 * @param attributes Initial attributes — must NOT contain PII or secrets.
 * @param fn         Work to execute inside the span.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const childContext = createChildContext();
  const span: Span = {
    name,
    traceId: childContext.traceId,
    spanId: childContext.spanId,
    parentSpanId: childContext.parentSpanId,
    startTime: childContext.startTime,
    attributes: { ...attributes },
  };

  try {
    const result = await runWithTraceContext(childContext, () => fn(span));

    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    span.attributes.outcome = "ok";
    span.attributes.latency = span.duration;

    emitSpan(span);
    return result;
  } catch (error) {
    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    span.attributes.outcome = "error";
    span.attributes.latency = span.duration;
    span.attributes.error = true;
    span.attributes["error.message"] =
      error instanceof Error ? error.message : String(error);

    emitSpan(span);
    throw error;
  }
}

/**
 * Returns a snapshot of the current span from the active AsyncLocalStorage context.
 */
export function getCurrentSpan(): Partial<Span> | undefined {
  const context = getTraceContext();
  if (!context) return undefined;
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    startTime: context.startTime,
  };
}
