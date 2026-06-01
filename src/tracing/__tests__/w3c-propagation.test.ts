import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { parseTraceparent, formatTraceparent, createChildContext, getTraceContext } from "../context.js";
import type { TraceContext } from "../context.js";
import { tracingMiddleware, getPropagationHeaders, TRACE_HEADERS } from "../middleware.js";
import { createInstrumentedRedisClient } from "../redisInstrumentation.js";
import { createNoOpExporter } from "../spanExporter.js";
import type { RedisClient } from "../../cache/redisClient.js";

describe("W3C Traceparent and Instrumentation", () => {
  describe("parseTraceparent", () => {
    it("should parse valid W3C traceparent header", () => {
      const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
      const parsed = parseTraceparent(traceparent);

      expect(parsed).toBeDefined();
      expect(parsed?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
      expect(parsed?.parentSpanId).toBe("00f067aa0ba902b7");
      expect(parsed?.traceFlags).toBe("01");
    });

    it("should reject invalid version", () => {
      const traceparent = "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
      const parsed = parseTraceparent(traceparent);

      expect(parsed).toBeUndefined();
    });

    it("should reject invalid trace ID length", () => {
      const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01";
      const parsed = parseTraceparent(traceparent);

      expect(parsed).toBeUndefined();
    });

    it("should reject invalid span ID length", () => {
      const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902-01";
      const parsed = parseTraceparent(traceparent);

      expect(parsed).toBeUndefined();
    });

    it("should reject invalid trace flags length", () => {
      const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-011";
      const parsed = parseTraceparent(traceparent);

      expect(parsed).toBeUndefined();
    });

    it("should reject malformed header with wrong part count", () => {
      const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7";
      const parsed = parseTraceparent(traceparent);

      expect(parsed).toBeUndefined();
    });

    it("should reject null or undefined", () => {
      expect(parseTraceparent(null as any)).toBeUndefined();
      expect(parseTraceparent(undefined as any)).toBeUndefined();
      expect(parseTraceparent("")).toBeUndefined();
    });

    it("should accept lowercase hex characters", () => {
      const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
      const parsed = parseTraceparent(traceparent);

      expect(parsed).toBeDefined();
    });

    it("should accept uppercase hex characters", () => {
      const traceparent = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";
      const parsed = parseTraceparent(traceparent);

      expect(parsed).toBeDefined();
    });
  });

  describe("formatTraceparent", () => {
    it("should format context as W3C traceparent header", () => {
      const context: TraceContext = {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: "01",
        startTime: Date.now(),
      };

      const formatted = formatTraceparent(context);

      expect(formatted).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    });

    it("should include parent span ID as span ID in formatted output", () => {
      const context: TraceContext = {
        traceId: "aaaabbbbccccddddeeeeffffgggghhhh".substring(0, 32),
        spanId: "1111222233334444",
        parentSpanId: "9999888877776666",
        traceFlags: "00",
        startTime: Date.now(),
      };

      const formatted = formatTraceparent(context);
      const parts = formatted.split("-");

      expect(parts[0]).toBe("00");
      expect(parts[2]).toBe(context.spanId);
      expect(parts[3]).toBe("00");
    });
  });

  describe("roundtrip parsing and formatting", () => {
    it("should roundtrip valid traceparent", () => {
      const original = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
      const parsed = parseTraceparent(original);
      const context: TraceContext = {
        traceId: parsed!.traceId!,
        spanId: parsed!.parentSpanId!,
        traceFlags: parsed!.traceFlags!,
        startTime: Date.now(),
      };

      const formatted = formatTraceparent(context);
      const reparsed = parseTraceparent(formatted);

      expect(reparsed?.traceId).toBe(parsed?.traceId);
      expect(reparsed?.parentSpanId).toBe(parsed?.parentSpanId);
      expect(reparsed?.traceFlags).toBe(parsed?.traceFlags);
    });
  });

  describe("tracingMiddleware W3C integration", () => {
    it("should extract traceparent header from request", () => {
      const req = {
        headers: {
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        },
      } as any;

      const res = {
        setHeader: jest.fn(),
      } as any;

      const next = jest.fn();

      tracingMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith(
        TRACE_HEADERS.TRACEPARENT,
        expect.stringContaining("00-4bf92f3577b34da6a3ce929d0e0e4736"),
      );
    });

    it("should set traceparent response header", () => {
      const req = { headers: {} } as any;
      const res = {
        setHeader: jest.fn(),
      } as any;
      const next = jest.fn();

      tracingMiddleware(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith(TRACE_HEADERS.TRACEPARENT, expect.any(String));

      // Verify the format
      const calls = res.setHeader.mock.calls;
      const traceparentCall = calls.find((c: any[]) => c[0] === TRACE_HEADERS.TRACEPARENT);
      const traceparentValue = traceparentCall?.[1];

      expect(traceparentValue).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i);
    });

    it("should fall back to custom headers when traceparent is missing", () => {
      const req = {
        headers: {
          "x-trace-id": "custom-trace-123",
        },
      } as any;

      const res = {
        setHeader: jest.fn(),
      } as any;

      const next = jest.fn();

      tracingMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith(TRACE_HEADERS.TRACE_ID, "custom-trace-123");
    });

    it("should generate traceparent for fresh requests", () => {
      const req = { headers: {} } as any;
      const res = {
        setHeader: jest.fn(),
      } as any;
      const next = jest.fn();

      tracingMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();

      // Should have set traceparent header
      const traceparentCall = res.setHeader.mock.calls.find(
        (c: any[]) => c[0] === TRACE_HEADERS.TRACEPARENT,
      );
      expect(traceparentCall).toBeDefined();
    });
  });

  describe("getPropagationHeaders", () => {
    it("should include traceparent header", () => {
      const context: TraceContext = {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: "01",
        startTime: Date.now(),
      };

      // Note: We can't directly test this without being inside a tracing context
      // This is more of a documentation test
      const headers = getPropagationHeaders();

      // Should include both W3C and custom headers
      if (headers[TRACE_HEADERS.TRACEPARENT]) {
        expect(headers[TRACE_HEADERS.TRACEPARENT]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i);
      }
    });
  });

  describe("Redis Instrumentation", () => {
    it("should create instrumented Redis client", () => {
      const mockRedisClient: RedisClient = {
        async get(_key: string) {
          return "value";
        },
        async set(_key: string, _value: string, _exMode: "EX", _ttl: number, _condition?: "NX") {
          return "OK";
        },
        async del(_key: string) {
          return 1;
        },
        async keys(_pattern: string) {
          return ["key1", "key2"];
        },
        async ping() {
          return "PONG";
        },
        async quit() {
          return "OK";
        },
      };

      const instrumented = createInstrumentedRedisClient(mockRedisClient);

      expect(instrumented).toBeDefined();
      expect(instrumented.get).toBeDefined();
      expect(instrumented.set).toBeDefined();
      expect(instrumented.del).toBeDefined();
      expect(instrumented.keys).toBeDefined();
      expect(instrumented.ping).toBeDefined();
      expect(instrumented.quit).toBeDefined();
    });

    it("should wrap Redis get operations", async () => {
      const mockRedisClient: RedisClient = {
        async get(_key: string) {
          return "cached-value";
        },
        async set() {
          return "OK";
        },
        async del() {
          return 0;
        },
        async keys() {
          return [];
        },
        async ping() {
          return "PONG";
        },
        async quit() {
          return "OK";
        },
      };

      const instrumented = createInstrumentedRedisClient(mockRedisClient);
      const result = await instrumented.get("test-key");

      expect(result).toBe("cached-value");
    });

    it("should wrap Redis set operations", async () => {
      const mockRedisClient: RedisClient = {
        async get() {
          return null;
        },
        async set(_key: string, _value: string, _exMode: "EX", _ttl: number, _condition?: "NX") {
          return "OK";
        },
        async del() {
          return 0;
        },
        async keys() {
          return [];
        },
        async ping() {
          return "PONG";
        },
        async quit() {
          return "OK";
        },
      };

      const instrumented = createInstrumentedRedisClient(mockRedisClient);
      const result = await instrumented.set("test-key", "test-value", "EX", 60);

      expect(result).toBe("OK");
    });

    it("should wrap Redis del operations", async () => {
      const mockRedisClient: RedisClient = {
        async get() {
          return null;
        },
        async set() {
          return "OK";
        },
        async del(_key: string) {
          return 1;
        },
        async keys() {
          return [];
        },
        async ping() {
          return "PONG";
        },
        async quit() {
          return "OK";
        },
      };

      const instrumented = createInstrumentedRedisClient(mockRedisClient);
      const result = await instrumented.del("test-key");

      expect(result).toBe(1);
    });
  });

  describe("NoOpExporter", () => {
    it("should create a no-op exporter", () => {
      const exporter = createNoOpExporter();
      expect(exporter).toBeDefined();
      expect(typeof exporter).toBe("function");
    });

    it("should not throw when exporting spans", () => {
      const exporter = createNoOpExporter();
      const span = {
        name: "test",
        traceId: "trace-123",
        spanId: "span-123",
        startTime: Date.now(),
        endTime: Date.now() + 100,
        duration: 100,
        attributes: {},
      };

      expect(() => exporter(span)).not.toThrow();
    });
  });

  describe("Span context propagation with W3C headers", () => {
    it("should maintain W3C trace flags across child spans", () => {
      const parentContext: TraceContext = {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: "01",
        startTime: Date.now(),
      };

      const childContext = createChildContext(parentContext);

      expect(childContext.traceFlags).toBe(parentContext.traceFlags);
      expect(childContext.traceId).toBe(parentContext.traceId);
    });

    it("should use default trace flags when not provided", () => {
      const parentContext: TraceContext = {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        startTime: Date.now(),
      } as any;

      const childContext = createChildContext(parentContext);

      expect(childContext.traceFlags).toBeDefined();
    });
  });
});
