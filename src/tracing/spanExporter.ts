import type { Span } from "./hooks.js";

export type SpanExporter = (span: Span) => void;

const exporters: SpanExporter[] = [];

/** Register a span exporter (e.g. for tests or a real collector). */
export function addSpanExporter(fn: SpanExporter): void {
  exporters.push(fn);
}

/** Remove a previously registered exporter. */
export function removeSpanExporter(fn: SpanExporter): void {
  const idx = exporters.indexOf(fn);
  if (idx !== -1) exporters.splice(idx, 1);
}

/** Emit a completed span to all registered exporters. */
export function emitSpan(span: Span): void {
  if (process.env.DEBUG_TRACING === "true") {
    const status = span.attributes.error ? "FAILED" : "OK";
    console.log(`[TRACING] ${span.name} ${status} ${span.duration}ms`, {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      attributes: span.attributes,
    });
  }
  for (const fn of exporters) {
    try {
      fn(span);
    } catch {
      // exporters must not crash the request
    }
  }
}
