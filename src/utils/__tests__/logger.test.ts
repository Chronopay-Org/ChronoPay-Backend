import { addTraceCorrelationToLog } from "../logger.js";
import {  runWithTraceContext } from "../../tracing/context.js";

describe("Logger trace correlation helper", () => {
  it("should copy traceId and spanId from active trace context into log object", () => {
    const context = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
      startTime: Date.now(),
    };

    runWithTraceContext(context, () => {
      const output = addTraceCorrelationToLog({ requestId: "req-1" });
      expect(output.traceId).toBe(context.traceId);
      expect(output.spanId).toBe(context.spanId);
    });
  });

  it("should fall back to requestId when no trace context is active", () => {
    const output = addTraceCorrelationToLog({ requestId: "req-1" });
    expect(output.traceId).toBe("req-1");
    expect(output.spanId).toBeUndefined();
  });
});
