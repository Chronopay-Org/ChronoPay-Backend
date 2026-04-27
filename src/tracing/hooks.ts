import { createChildContext, runWithTraceContext, getTraceContext } from "./context.js";

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
  attributes: Record<string, any>;
}

/**
 * Hook to manually instrument a synchronous or asynchronous function with a new span.
 * This automatically handles span lifecycle and context propagation.
 * 
 * @param name - The name of the span (e.g., "db.query", "api.call").
 * @param attributes - Metadata associated with the span.
 * @param fn - The function to execute within this span.
 * @returns The result of the function execution.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, any>,
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
    // Run the function within the new child context
    const result = await runWithTraceContext(childContext, () => fn(span));
    
    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    
    // In a real production system, we would export this span to a collector here
    // For now, we'll log it for visibility if in development
    if (process.env.DEBUG_TRACING === "true") {
      console.log(`[TRACING] Span "${name}" completed:`, span);
    }

    return result;
  } catch (error) {
    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    span.attributes.error = true;
    span.attributes["error.message"] = error instanceof Error ? error.message : String(error);

    if (process.env.DEBUG_TRACING === "true") {
      console.error(`[TRACING] Span "${name}" failed:`, span);
    }
    
    throw error;
  }
}

/**
 * Retrieves the current span information from the active context.
 * Useful for adding attributes to the current span dynamically.
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
