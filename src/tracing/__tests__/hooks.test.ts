import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { withSpan, getCurrentSpan, type Span } from "../hooks.js";
import { addSpanExporter, removeSpanExporter } from "../spanExporter.js";
import { getTraceContext, runWithTraceContext, generateId, createChildContext } from "../context.js";

describe("tracing hooks and exporter", () => {
  const collectedSpans: Span[] = [];
  let exporter: (span: Span) => void;

  beforeEach(() => {
    collectedSpans.length = 0;
    exporter = (span: Span) => {
      collectedSpans.push({ ...span });
    };
    addSpanExporter(exporter);
  });

  afterEach(() => {
    removeSpanExporter(exporter);
    collectedSpans.length = 0;
  });

  describe("withSpan", () => {
    it("should return the wrapped value for synchronous operations", async () => {
      const result = await withSpan("test.sync", { key: "value" }, () => {
        return 42;
      });

      expect(result).toBe(42);
      expect(collectedSpans).toHaveLength(1);
      expect(collectedSpans[0].name).toBe("test.sync");
      expect(collectedSpans[0].attributes.key).toBe("value");
      expect(collectedSpans[0].attributes.outcome).toBe("ok");
      expect(collectedSpans[0].attributes.error).toBeUndefined();
    });

    it("should return the wrapped value for asynchronous operations", async () => {
      const result = await withSpan("test.async", { key: "value" }, async () => {
        return Promise.resolve(42);
      });

      expect(result).toBe(42);
      expect(collectedSpans).toHaveLength(1);
      expect(collectedSpans[0].name).toBe("test.async");
      expect(collectedSpans[0].attributes.key).toBe("value");
      expect(collectedSpans[0].attributes.outcome).toBe("ok");
    });

    it("should record latency and duration on successful operations", async () => {
      await withSpan("test.timing", {}, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      expect(span.duration).toBeGreaterThan(0);
      expect(span.attributes.latency).toBe(span.duration);
      expect(span.endTime).toBeGreaterThan(span.startTime);
    });

    it("should record custom attributes", async () => {
      await withSpan(
        "test.attributes",
        { route: "/api/test", method: "GET", userId: 123 },
        () => {
          return "success";
        },
      );

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      expect(span.attributes.route).toBe("/api/test");
      expect(span.attributes.method).toBe("GET");
      expect(span.attributes.userId).toBe(123);
    });

    it("should mark span as errored when function throws an error", async () => {
      const error = new Error("Test error");
      await expect(
        withSpan("test.error", {}, () => {
          throw error;
        }),
      ).rejects.toThrow("Test error");

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      expect(span.attributes.outcome).toBe("error");
      expect(span.attributes.error).toBe(true);
      expect(span.attributes["error.message"]).toBe("Test error");
    });

    it("should mark span as errored for async errors", async () => {
      const error = new Error("Async error");
      await expect(
        withSpan("test.async-error", {}, async () => {
          throw error;
        }),
      ).rejects.toThrow("Async error");

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      expect(span.attributes.outcome).toBe("error");
      expect(span.attributes.error).toBe(true);
      expect(span.attributes["error.message"]).toBe("Async error");
    });

    it("should record latency even on error", async () => {
      await expect(
        withSpan("test.error-timing", {}, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error("Error after delay");
        }),
      ).rejects.toThrow();

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      expect(span.duration).toBeGreaterThan(0);
      expect(span.attributes.latency).toBe(span.duration);
    });

    it("should handle non-Error objects thrown", async () => {
      await expect(
        withSpan("test.non-error", {}, () => {
          throw "string error";
        }),
      ).rejects.toThrow("string error");

      expect(collectedSpans).toHaveLength(1);
      const span = collectedSpans[0];
      expect(span.attributes.outcome).toBe("error");
      expect(span.attributes.error).toBe(true);
      expect(span.attributes["error.message"]).toBe("string error");
    });

    it("should provide span object to the wrapped function", async () => {
      let capturedSpan: Span | undefined;

      await withSpan("test.span-param", {}, (span) => {
        capturedSpan = span;
        return "result";
      });

      expect(capturedSpan).toBeDefined();
      expect(capturedSpan!.name).toBe("test.span-param");
      expect(capturedSpan!.traceId).toBeDefined();
      expect(capturedSpan!.spanId).toBeDefined();
      expect(capturedSpan!.startTime).toBeDefined();
    });

    it("should create nested spans with correct parent-child relationship", async () => {
      await withSpan("parent.span", {}, async (parentSpan) => {
        await withSpan("child.span", {}, async (childSpan) => {
          expect(childSpan.parentSpanId).toBe(parentSpan.spanId);
          expect(childSpan.traceId).toBe(parentSpan.traceId);
        });
      });

      expect(collectedSpans).toHaveLength(2);
      const parentSpan = collectedSpans.find((s) => s.name === "parent.span");
      const childSpan = collectedSpans.find((s) => s.name === "child.span");

      expect(parentSpan).toBeDefined();
      expect(childSpan).toBeDefined();
      expect(childSpan!.parentSpanId).toBe(parentSpan!.spanId);
      expect(childSpan!.traceId).toBe(parentSpan!.traceId);
    });

    it("should handle deeply nested spans", async () => {
      await withSpan("level1", {}, async () => {
        await withSpan("level2", {}, async () => {
          await withSpan("level3", {}, async () => {
            return "deep";
          });
        });
      });

      expect(collectedSpans).toHaveLength(3);
      const level1 = collectedSpans.find((s) => s.name === "level1");
      const level2 = collectedSpans.find((s) => s.name === "level2");
      const level3 = collectedSpans.find((s) => s.name === "level3");

      expect(level1).toBeDefined();
      expect(level2).toBeDefined();
      expect(level3).toBeDefined();
      expect(level2!.parentSpanId).toBe(level1!.spanId);
      expect(level3!.parentSpanId).toBe(level2!.spanId);
      expect(level3!.traceId).toBe(level1!.traceId);
    });

    it("should propagate errors through nested spans", async () => {
      const error = new Error("Nested error");

      await expect(
        withSpan("outer", {}, async () => {
          await withSpan("inner", {}, async () => {
            throw error;
          });
        }),
      ).rejects.toThrow("Nested error");

      expect(collectedSpans).toHaveLength(2);
      const outerSpan = collectedSpans.find((s) => s.name === "outer");
      const innerSpan = collectedSpans.find((s) => s.name === "inner");

      expect(innerSpan!.attributes.outcome).toBe("error");
      expect(innerSpan!.attributes.error).toBe(true);
      expect(outerSpan!.attributes.outcome).toBe("error");
      expect(outerSpan!.attributes.error).toBe(true);
    });

    it("should handle multiple sequential spans", async () => {
      await withSpan("span1", {}, () => "result1");
      await withSpan("span2", {}, () => "result2");
      await withSpan("span3", {}, () => "result3");

      expect(collectedSpans).toHaveLength(3);
      expect(collectedSpans[0].name).toBe("span1");
      expect(collectedSpans[1].name).toBe("span2");
      expect(collectedSpans[2].name).toBe("span3");
    });

    it("should generate unique span IDs for each span", async () => {
      const spanIds = new Set<string>();

      await withSpan("span1", {}, () => {
        spanIds.add(collectedSpans[0].spanId);
      });
      await withSpan("span2", {}, () => {
        spanIds.add(collectedSpans[1].spanId);
      });
      await withSpan("span3", {}, () => {
        spanIds.add(collectedSpans[2].spanId);
      });

      expect(spanIds.size).toBe(3);
    });
  });

  describe("getCurrentSpan", () => {
    it("should return undefined when not in a span context", () => {
      const currentSpan = getCurrentSpan();
      expect(currentSpan).toBeUndefined();
    });

    it("should return the current span when inside withSpan", async () => {
      let capturedSpan: ReturnType<typeof getCurrentSpan>;

      await withSpan("test.current", {}, () => {
        capturedSpan = getCurrentSpan();
        return "result";
      });

      expect(capturedSpan).toBeDefined();
      expect(capturedSpan!.traceId).toBeDefined();
      expect(capturedSpan!.spanId).toBeDefined();
      expect(capturedSpan!.startTime).toBeDefined();
    });

    it("should return the innermost span in nested contexts", async () => {
      let outerSpan: ReturnType<typeof getCurrentSpan>;
      let innerSpan: ReturnType<typeof getCurrentSpan>;

      await withSpan("outer", {}, async () => {
        outerSpan = getCurrentSpan();
        await withSpan("inner", {}, () => {
          innerSpan = getCurrentSpan();
          return "result";
        });
      });

      expect(outerSpan).toBeDefined();
      expect(innerSpan).toBeDefined();
      expect(innerSpan!.spanId).not.toBe(outerSpan!.spanId);
    });
  });

  describe("spanExporter", () => {
    it("should call registered exporters when span is emitted", async () => {
      const calls: Span[] = [];
      const testExporter = (span: Span) => {
        calls.push(span);
      };

      addSpanExporter(testExporter);
      await withSpan("test.exporter", {}, () => "result");
      removeSpanExporter(testExporter);

      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("test.exporter");
    });

    it("should call multiple registered exporters", async () => {
      const calls1: Span[] = [];
      const calls2: Span[] = [];
      const exporter1 = (span: Span) => calls1.push(span);
      const exporter2 = (span: Span) => calls2.push(span);

      addSpanExporter(exporter1);
      addSpanExporter(exporter2);
      await withSpan("test.multi", {}, () => "result");
      removeSpanExporter(exporter1);
      removeSpanExporter(exporter2);

      expect(calls1).toHaveLength(1);
      expect(calls2).toHaveLength(1);
      expect(calls1[0].name).toBe("test.multi");
      expect(calls2[0].name).toBe("test.multi");
    });

    it("should not call removed exporters", async () => {
      const calls: Span[] = [];
      const exporter = (span: Span) => calls.push(span);

      addSpanExporter(exporter);
      removeSpanExporter(exporter);
      await withSpan("test.removed", {}, () => "result");

      expect(calls).toHaveLength(0);
    });

    it("should handle exporter errors gracefully", async () => {
      const failingExporter = () => {
        throw new Error("Exporter failed");
      };
      const workingExporter = (span: Span) => {
        collectedSpans.push(span);
      };

      addSpanExporter(failingExporter);
      addSpanExporter(workingExporter);
      await withSpan("test.error-handling", {}, () => "result");
      removeSpanExporter(failingExporter);
      removeSpanExporter(workingExporter);

      // The working exporter should still be called despite the failing one
      expect(collectedSpans).toHaveLength(1);
      expect(collectedSpans[0].name).toBe("test.error-handling");
    });

    it("should allow removing specific exporter from multiple", async () => {
      const calls1: Span[] = [];
      const calls2: Span[] = [];
      const exporter1 = (span: Span) => calls1.push(span);
      const exporter2 = (span: Span) => calls2.push(span);

      addSpanExporter(exporter1);
      addSpanExporter(exporter2);
      removeSpanExporter(exporter1);
      await withSpan("test.selective-remove", {}, () => "result");
      removeSpanExporter(exporter2);

      expect(calls1).toHaveLength(0);
      expect(calls2).toHaveLength(1);
    });
  });

  describe("context", () => {
    it("should return undefined when no context is set", () => {
      const context = getTraceContext();
      expect(context).toBeUndefined();
    });

    it("should return the context when set", () => {
      const testContext = {
        traceId: "test-trace-id",
        spanId: "test-span-id",
        startTime: Date.now(),
      };

      const result = runWithTraceContext(testContext, () => {
        return getTraceContext();
      });

      expect(result).toEqual(testContext);
    });

    it("should generate unique IDs", () => {
      const id1 = generateId();
      const id2 = generateId();
      const id3 = generateId();

      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id3).toBeDefined();
      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });

    it("should generate valid UUID format", () => {
      const id = generateId();
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(id).toMatch(uuidRegex);
    });

    it("should create child context with new span ID", () => {
      const parentContext = {
        traceId: "parent-trace",
        spanId: "parent-span",
        startTime: Date.now(),
      };

      const childContext = createChildContext(parentContext);

      expect(childContext.traceId).toBe(parentContext.traceId);
      expect(childContext.spanId).not.toBe(parentContext.spanId);
      expect(childContext.parentSpanId).toBe(parentContext.spanId);
      expect(childContext.startTime).toBeGreaterThanOrEqual(parentContext.startTime);
    });

    it("should create child context from current context when no parent provided", async () => {
      const parentContext = {
        traceId: "current-trace",
        spanId: "current-span",
        startTime: Date.now(),
      };

      const childContext = runWithTraceContext(parentContext, () => {
        return createChildContext();
      });

      expect(childContext.traceId).toBe(parentContext.traceId);
      expect(childContext.spanId).not.toBe(parentContext.spanId);
      expect(childContext.parentSpanId).toBe(parentContext.spanId);
    });

    it("should create new trace context when no current context exists", () => {
      const childContext = createChildContext();

      expect(childContext.traceId).toBeDefined();
      expect(childContext.spanId).toBeDefined();
      expect(childContext.parentSpanId).toBeUndefined();
      expect(childContext.startTime).toBeDefined();
    });

    it("should isolate contexts between different runs", () => {
      const context1 = { traceId: "trace1", spanId: "span1", startTime: Date.now() };
      const context2 = { traceId: "trace2", spanId: "span2", startTime: Date.now() };

      const result1 = runWithTraceContext(context1, () => getTraceContext());
      const result2 = runWithTraceContext(context2, () => getTraceContext());

      expect(result1).toEqual(context1);
      expect(result2).toEqual(context2);
    });
  });

  describe("integration tests", () => {
    it("should trace a complete operation flow with multiple spans", async () => {
      const results: string[] = [];

      await withSpan("operation.start", { operation: "test" }, async () => {
        results.push("start");
        await withSpan("operation.process", { step: 1 }, async () => {
          results.push("process");
          await withSpan("operation.validate", {}, () => {
            results.push("validate");
          });
        });
        await withSpan("operation.finish", {}, () => {
          results.push("finish");
        });
      });

      expect(results).toEqual(["start", "process", "validate", "finish"]);
      expect(collectedSpans).toHaveLength(4);

      const startSpan = collectedSpans.find((s) => s.name === "operation.start");
      const processSpan = collectedSpans.find((s) => s.name === "operation.process");
      const validateSpan = collectedSpans.find((s) => s.name === "operation.validate");
      const finishSpan = collectedSpans.find((s) => s.name === "operation.finish");

      expect(startSpan!.attributes.operation).toBe("test");
      expect(processSpan!.attributes.step).toBe(1);
      expect(validateSpan!.parentSpanId).toBe(processSpan!.spanId);
      expect(finishSpan!.parentSpanId).toBe(startSpan!.spanId);
    });

    it("should handle error recovery in nested spans", async () => {
      let errorCaught = false;

      await withSpan("outer.operation", {}, async () => {
        try {
          await withSpan("inner.operation", {}, async () => {
            throw new Error("Inner failure");
          });
        // eslint-disable-next-line unused-imports/no-unused-vars
        } catch (error) {
          errorCaught = true;
          // Continue with recovery
          await withSpan("recovery.operation", {}, () => {
            return "recovered";
          });
        }
      });

      expect(errorCaught).toBe(true);
      expect(collectedSpans).toHaveLength(3);

      const innerSpan = collectedSpans.find((s) => s.name === "inner.operation");
      const recoverySpan = collectedSpans.find((s) => s.name === "recovery.operation");

      expect(innerSpan!.attributes.outcome).toBe("error");
      expect(recoverySpan!.attributes.outcome).toBe("ok");
    });

    it("should maintain trace ID across all spans in a trace", async () => {
      await withSpan("root", {}, async () => {
        await withSpan("child1", {}, async () => {
          await withSpan("grandchild1", {}, () => {});
        });
        await withSpan("child2", {}, async () => {
          await withSpan("grandchild2", {}, () => {});
        });
      });

      expect(collectedSpans).toHaveLength(5);
      const traceIds = collectedSpans.map((s) => s.traceId);
      const uniqueTraceIds = new Set(traceIds);

      expect(uniqueTraceIds.size).toBe(1);
    });
  });
});
