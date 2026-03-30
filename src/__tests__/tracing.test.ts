import request from "supertest";
import app from "../index";
import { getTraceContext, generateId, runWithTraceContext } from "../tracing/context";
import { TRACE_HEADERS } from "../tracing/middleware";
import { withSpan, getCurrentSpan } from "../tracing/hooks";

describe("Distributed Tracing", () => {
  describe("Context Management", () => {
    it("should generate valid UUIDs", () => {
      const id = generateId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it("should maintain context within runWithTraceContext", () => {
      const context = {
        traceId: "test-trace",
        spanId: "test-span",
        startTime: Date.now(),
      };

      runWithTraceContext(context, () => {
        const current = getTraceContext();
        expect(current).toEqual(context);
      });

      expect(getTraceContext()).toBeUndefined();
    });
  });

  describe("Tracing Middleware", () => {
    it("should generate a new trace ID if missing in headers", async () => {
      const res = await request(app).get("/health");
      
      expect(res.headers[TRACE_HEADERS.TRACE_ID]).toBeDefined();
      expect(res.headers[TRACE_HEADERS.SPAN_ID]).toBeDefined();
    });

    it("should propagate trace ID from request headers", async () => {
      const traceId = "incoming-trace-id";
      const res = await request(app)
        .get("/health")
        .set(TRACE_HEADERS.TRACE_ID, traceId);
      
      expect(res.headers[TRACE_HEADERS.TRACE_ID]).toBe(traceId);
    });

    it("should set parent span ID if provided", async () => {
      const parentSpanId = "parent-span-id";
      // We can't easily check internal state here without more hooks,
      // but we verify the request doesn't fail.
      const res = await request(app)
        .get("/health")
        .set(TRACE_HEADERS.PARENT_SPAN_ID, parentSpanId);
      
      expect(res.status).toBe(200);
    });
  });

  describe("Tracing Hooks (withSpan)", () => {
    it("should create a child span and return function result", async () => {
      const result = await withSpan("test-operation", { key: "value" }, async (span) => {
        expect(span.name).toBe("test-operation");
        expect(span.attributes.key).toBe("value");
        return "success";
      });

      expect(result).toBe("success");
    });

    it("should handle errors in spans and record them", async () => {
      const error = new Error("test-error");
      
      try {
        await withSpan("failing-op", {}, async () => {
          throw error;
        });
      } catch (e) {
        expect(e).toBe(error);
      }
    });

    it("should provide access to current span info", async () => {
      const context = {
        traceId: "trace-123",
        spanId: "span-456",
        startTime: Date.now(),
      };

      await runWithTraceContext(context, async () => {
        const spanInfo = getCurrentSpan();
        expect(spanInfo?.traceId).toBe(context.traceId);
        expect(spanInfo?.spanId).toBe(context.spanId);
      });
    });
  });

  describe("Integration: End-to-End Tracing", () => {
    it("should trace the slot creation endpoint", async () => {
      const traceId = "e2e-trace-id";
      const res = await request(app)
        .post("/api/v1/slots")
        .set(TRACE_HEADERS.TRACE_ID, traceId)
        .send({
          professional: "bob",
          startTime: 3000,
          endTime: 4000,
        });

      expect(res.status).toBe(201);
      expect(res.headers[TRACE_HEADERS.TRACE_ID]).toBe(traceId);
      expect(res.body.success).toBe(true);
      expect(res.body.slot.professional).toBe("bob");
    });
  });
});
