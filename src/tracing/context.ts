import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Interface representing the tracing context.
 * This structure holds trace-related metadata for distributed tracing.
 */
export interface TraceContext {
  /** Global identifier for the entire request path across services */
  traceId: string;
  /** Identifier for the current unit of work (span) */
  spanId: string;
  /** Identifier for the parent span, if any */
  parentSpanId?: string;
  /** Timestamp when the span started */
  startTime: number;
}

/**
 * Global storage for tracing context, leveraging Node.js AsyncLocalStorage.
 * This allows us to access the current trace context anywhere in the call stack
 * without explicit parameter passing.
 */
const tracingStorage = new AsyncLocalStorage<TraceContext>();

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
 * Generates a new unique trace identifier.
 * Uses standard UUID v4 for compliance with distributed systems.
 */
export function generateId(): string {
  return randomUUID();
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
    traceId: current?.traceId || generateId(),
    spanId: generateId(),
    parentSpanId: current?.spanId,
    startTime: Date.now(),
  };
}
