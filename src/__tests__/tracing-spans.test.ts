/**
 * Tests for core flow tracing spans (issue #131).
 *
 * Covers:
 *  - spanExporter: registration, removal, emit
 *  - withSpan: ok path, error path, nested/async propagation
 *  - SlotService traced wrappers
 *  - CheckoutSessionService traced wrappers
 *  - BookingIntentService traced wrapper
 *  - No PII in span attributes
 */

import { runWithTraceContext, getTraceContext } from "../tracing/context.js";
import { withSpan, getCurrentSpan } from "../tracing/hooks.js";
import {
  addSpanExporter,
  removeSpanExporter,
  emitSpan,
} from "../tracing/spanExporter.js";
import type { Span } from "../tracing/hooks.js";
import { SlotService } from "../services/slotService.js";
import { CheckoutSessionService } from "../services/checkout.js";
import { BookingIntentService } from "../modules/booking-intents/booking-intent-service.js";
import { InMemoryBookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function collectSpans(): { spans: Span[]; cleanup: () => void } {
  const spans: Span[] = [];
  const exporter = (s: Span) => spans.push(s);
  addSpanExporter(exporter);
  return { spans, cleanup: () => removeSpanExporter(exporter) };
}

// ─── spanExporter ─────────────────────────────────────────────────────────────

describe("spanExporter", () => {
  it("calls registered exporter with emitted span", () => {
    const received: Span[] = [];
    const fn = (s: Span) => received.push(s);
    addSpanExporter(fn);

    const span: Span = {
      name: "test",
      traceId: "t1",
      spanId: "s1",
      startTime: Date.now(),
      endTime: Date.now(),
      duration: 1,
      attributes: { outcome: "ok", latency: 1 },
    };
    emitSpan(span);

    expect(received).toHaveLength(1);
    expect(received[0].name).toBe("test");
    removeSpanExporter(fn);
  });

  it("does not call exporter after removal", () => {
    const received: Span[] = [];
    const fn = (s: Span) => received.push(s);
    addSpanExporter(fn);
    removeSpanExporter(fn);

    emitSpan({ name: "x", traceId: "t", spanId: "s", startTime: 0, attributes: {} });
    expect(received).toHaveLength(0);
  });

  it("swallows exporter errors so the request is not affected", () => {
    const boom = () => { throw new Error("exporter crash"); };
    addSpanExporter(boom);
    expect(() =>
      emitSpan({ name: "x", traceId: "t", spanId: "s", startTime: 0, attributes: {} }),
    ).not.toThrow();
    removeSpanExporter(boom);
  });
});

// ─── withSpan ─────────────────────────────────────────────────────────────────

describe("withSpan", () => {
  it("records outcome=ok and latency on success", async () => {
    const { spans, cleanup } = collectSpans();
    await withSpan("op.success", { route: "GET /test" }, async () => "result");
    cleanup();

    expect(spans).toHaveLength(1);
    expect(spans[0].attributes.outcome).toBe("ok");
    expect(typeof spans[0].attributes.latency).toBe("number");
    expect(spans[0].attributes.error).toBeUndefined();
  });

  it("records outcome=error and error.message on failure", async () => {
    const { spans, cleanup } = collectSpans();
    await expect(
      withSpan("op.fail", {}, async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");
    cleanup();

    expect(spans[0].attributes.outcome).toBe("error");
    expect(spans[0].attributes.error).toBe(true);
    expect(spans[0].attributes["error.message"]).toBe("boom");
  });

  it("propagates async context so child can read parent traceId", async () => {
    const parentCtx = {
      traceId: "parent-trace",
      spanId: "parent-span",
      startTime: Date.now(),
    };

    await runWithTraceContext(parentCtx, async () => {
      await withSpan("child.op", {}, async (span) => {
        // child span must inherit the parent traceId
        expect(span.traceId).toBe("parent-trace");
        expect(span.parentSpanId).toBe("parent-span");
      });
    });
  });

  it("nested spans each get unique spanIds", async () => {
    const { spans, cleanup } = collectSpans();
    await withSpan("outer", {}, async () => {
      await withSpan("inner", {}, async () => "done");
    });
    cleanup();

    expect(spans).toHaveLength(2);
    expect(spans[0].spanId).not.toBe(spans[1].spanId);
  });

  it("does not include PII fields in attributes", async () => {
    const { spans, cleanup } = collectSpans();
    await withSpan("slots.create", { route: "POST /api/v1/slots" }, async () => "ok");
    cleanup();

    const attrs = spans[0].attributes;
    const keys = Object.keys(attrs);
    const piiKeys = ["email", "password", "token", "customerId", "userId", "phone"];
    for (const pii of piiKeys) {
      expect(keys).not.toContain(pii);
    }
  });

  it("getCurrentSpan returns context inside withSpan", async () => {
    await withSpan("ctx.check", {}, async () => {
      const current = getCurrentSpan();
      expect(current).toBeDefined();
      expect(current?.traceId).toBeDefined();
    });
  });

  it("getCurrentSpan returns undefined outside any context", () => {
    expect(getCurrentSpan()).toBeUndefined();
  });
});

// ─── SlotService traced wrappers ──────────────────────────────────────────────

describe("SlotService traced wrappers", () => {
  let service: SlotService;

  beforeEach(() => {
    service = new SlotService();
  });

  it("createSlotTraced emits a span with route attribute", async () => {
    const { spans, cleanup } = collectSpans();
    await service.createSlotTraced({ professional: "alice", startTime: 1000, endTime: 2000 });
    cleanup();

    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("slots.create");
    expect(spans[0].attributes.route).toBe("POST /api/v1/slots");
    expect(spans[0].attributes.outcome).toBe("ok");
  });

  it("createSlotTraced records error outcome on validation failure", async () => {
    const { spans, cleanup } = collectSpans();
    await expect(
      service.createSlotTraced({ professional: "", startTime: 1000, endTime: 2000 }),
    ).rejects.toThrow();
    cleanup();

    expect(spans[0].attributes.outcome).toBe("error");
    expect(spans[0].attributes.error).toBe(true);
  });

  it("updateSlotTraced emits a span with slotId attribute", async () => {
    const slot = service.createSlot({ professional: "bob", startTime: 100, endTime: 200 });
    const { spans, cleanup } = collectSpans();
    await service.updateSlotTraced(slot.id, { endTime: 300 });
    cleanup();

    expect(spans[0].name).toBe("slots.update");
    expect(spans[0].attributes.slotId).toBe(slot.id);
    expect(spans[0].attributes.outcome).toBe("ok");
  });

  it("updateSlotTraced records error on not-found", async () => {
    const { spans, cleanup } = collectSpans();
    await expect(service.updateSlotTraced(9999, { endTime: 300 })).rejects.toThrow();
    cleanup();

    expect(spans[0].attributes.outcome).toBe("error");
  });

  it("listSlotsTraced emits a span", async () => {
    const { spans, cleanup } = collectSpans();
    await service.listSlotsTraced();
    cleanup();

    expect(spans[0].name).toBe("slots.list");
    expect(spans[0].attributes.route).toBe("GET /api/v1/slots");
    expect(spans[0].attributes.outcome).toBe("ok");
  });
});

// ─── CheckoutSessionService traced wrappers ───────────────────────────────────

describe("CheckoutSessionService traced wrappers", () => {
  const validRequest = {
    payment: { amount: 100, currency: "USD" as const, paymentMethod: "credit_card" as const },
    customer: { customerId: "cust-1", email: "test@example.com" },
  };

  beforeEach(() => {
    CheckoutSessionService.clearAllSessions();
  });

  it("createSessionTraced emits a span without PII", async () => {
    const { spans, cleanup } = collectSpans();
    await CheckoutSessionService.createSessionTraced(validRequest);
    cleanup();

    expect(spans[0].name).toBe("checkout.createSession");
    expect(spans[0].attributes.outcome).toBe("ok");
    // paymentMethod is safe; email/customerId must not appear
    expect(spans[0].attributes.paymentMethod).toBe("credit_card");
    expect(Object.keys(spans[0].attributes)).not.toContain("email");
    expect(Object.keys(spans[0].attributes)).not.toContain("customerId");
  });

  it("getSessionTraced emits a span", async () => {
    const session = CheckoutSessionService.createSession(validRequest);
    const { spans, cleanup } = collectSpans();
    await CheckoutSessionService.getSessionTraced(session.id);
    cleanup();

    expect(spans[0].name).toBe("checkout.getSession");
    expect(spans[0].attributes.outcome).toBe("ok");
  });

  it("getSessionTraced records error for missing session", async () => {
    const { spans, cleanup } = collectSpans();
    await expect(
      CheckoutSessionService.getSessionTraced("nonexistent-id"),
    ).rejects.toThrow();
    cleanup();

    expect(spans[0].attributes.outcome).toBe("error");
  });

  it("completeSessionTraced emits a span", async () => {
    const session = CheckoutSessionService.createSession(validRequest);
    const { spans, cleanup } = collectSpans();
    await CheckoutSessionService.completeSessionTraced(session.id);
    cleanup();

    expect(spans[0].name).toBe("checkout.completeSession");
    expect(spans[0].attributes.outcome).toBe("ok");
  });

  it("cancelSessionTraced emits a span", async () => {
    const session = CheckoutSessionService.createSession(validRequest);
    const { spans, cleanup } = collectSpans();
    await CheckoutSessionService.cancelSessionTraced(session.id);
    cleanup();

    expect(spans[0].name).toBe("checkout.cancelSession");
    expect(spans[0].attributes.outcome).toBe("ok");
  });
});

// ─── BookingIntentService traced wrapper ──────────────────────────────────────

describe("BookingIntentService traced wrapper", () => {
  function makeService() {
    const slotRepo = new InMemorySlotRepository([
      { id: "slot-1", professional: "pro-1", bookable: true, startTime: 1_900_000_000_000, endTime: 1_900_000_360_000 },
    ]);
    const intentRepo = new InMemoryBookingIntentRepository();
    return new BookingIntentService(intentRepo, slotRepo);
  }

  it("createIntentTraced emits a span with route attribute", async () => {
    const service = makeService();
    const { spans, cleanup } = collectSpans();
    await service.createIntentTraced(
      { slotId: "slot-1" },
      { userId: "cust-1", role: "customer" },
    );
    cleanup();

    expect(spans[0].name).toBe("bookingIntents.create");
    expect(spans[0].attributes.route).toBe("POST /api/v1/booking-intents");
    expect(spans[0].attributes.outcome).toBe("ok");
  });

  it("createIntentTraced records error when slot not found", async () => {
    const service = makeService();
    const { spans, cleanup } = collectSpans();
    await expect(
      service.createIntentTraced({ slotId: "missing" }, { userId: "cust-1", role: "customer" }),
    ).rejects.toThrow();
    cleanup();

    expect(spans[0].attributes.outcome).toBe("error");
  });

  it("createIntentTraced records error when professional tries to book own slot", async () => {
    const service = makeService();
    const { spans, cleanup } = collectSpans();
    await expect(
      service.createIntentTraced({ slotId: "slot-1" }, { userId: "pro-1", role: "customer" }),
    ).rejects.toThrow();
    cleanup();

    expect(spans[0].attributes.outcome).toBe("error");
    // userId must NOT appear in span attributes
    expect(Object.keys(spans[0].attributes)).not.toContain("userId");
  });
});

// ─── Async context propagation across await boundaries ────────────────────────

describe("async context propagation", () => {
  it("preserves traceId across multiple awaits", async () => {
    const ctx = { traceId: "async-trace", spanId: "async-span", startTime: Date.now() };

    await runWithTraceContext(ctx, async () => {
      await Promise.resolve(); // yield
      expect(getTraceContext()?.traceId).toBe("async-trace");

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(getTraceContext()?.traceId).toBe("async-trace");
    });
  });

  it("isolates context between concurrent spans", async () => {
    const results: string[] = [];

    await Promise.all([
      withSpan("span-a", {}, async () => {
        await new Promise<void>((r) => setTimeout(r, 5));
        results.push(getTraceContext()?.spanId ?? "none");
      }),
      withSpan("span-b", {}, async () => {
        await new Promise<void>((r) => setTimeout(r, 2));
        results.push(getTraceContext()?.spanId ?? "none");
      }),
    ]);

    // Both spans ran and each had its own spanId
    expect(results).toHaveLength(2);
    expect(results[0]).not.toBe(results[1]);
  });
});
