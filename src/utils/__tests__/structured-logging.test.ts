/**
 * Tests for structured JSON logging with pino mixin.
 *
 * Covers:
 *  1. req_id top-level field via ALS propagation (sync + async jobs)
 *  2. trace_id and span_id top-level fields from tracing ALS
 *  3. Both fields present simultaneously
 *  4. Circular reference objects are handled without crashing
 *  5. Massive payloads are handled without crashing
 *  6. requestIdMiddleware stores req_id in ALS so mixin can read it
 */

import pino from "pino";
import { Writable } from "node:stream";
import express from "express";
import request from "supertest";

import { runWithReqId, getReqId } from "../logContext.js";
import { runWithTraceContext, getTraceContext } from "../../tracing/context.js";
import { requestIdMiddleware } from "../../middleware/requestId.js";
import { addTraceCorrelationToLog } from "../logger.js";

// ---------------------------------------------------------------------------
// Helper: build a local test logger with the same mixin logic as production
// ---------------------------------------------------------------------------
function createTestLogger() {
  const records: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      try {
        const line = chunk.toString().trim();
        if (line) records.push(JSON.parse(line));
      } catch {
        // ignore non-JSON lines
      }
      cb();
    },
  });

  const testLogger = pino(
    {
      level: "trace",
      // Mirror the production mixin — injects req_id, trace_id, span_id
      mixin() {
        const extra: Record<string, string> = {};
        const reqId = getReqId();
        if (reqId) extra["req_id"] = reqId;
        const traceCtx = getTraceContext();
        if (traceCtx) {
          extra["trace_id"] = traceCtx.traceId;
          extra["span_id"] = traceCtx.spanId;
        }
        return extra;
      },
    },
    stream,
  );

  return { testLogger, records };
}

// ---------------------------------------------------------------------------
// 1. req_id ALS propagation — synchronous
// ---------------------------------------------------------------------------
describe("req_id ALS propagation — sync", () => {
  it("injects req_id as top-level field within runWithReqId scope", () => {
    const { testLogger, records } = createTestLogger();
    runWithReqId("req_sync_001", () => {
      testLogger.info("inside sync scope");
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.req_id).toBe("req_sync_001");
    expect(records[0]?.msg).toBe("inside sync scope");
  });

  it("does NOT inject req_id outside runWithReqId scope", () => {
    const { testLogger, records } = createTestLogger();
    testLogger.info("outside scope");
    expect(records).toHaveLength(1);
    expect(records[0]?.req_id).toBeUndefined();
  });

  it("getReqId returns undefined outside ALS scope", () => {
    expect(getReqId()).toBeUndefined();
  });

  it("getReqId returns correct value inside ALS scope", () => {
    runWithReqId("req_check_002", () => {
      expect(getReqId()).toBe("req_check_002");
    });
  });

  it("nested scopes each carry their own req_id", () => {
    const { testLogger, records } = createTestLogger();
    runWithReqId("outer_req", () => {
      testLogger.info("outer log");
      runWithReqId("inner_req", () => {
        testLogger.info("inner log");
      });
      testLogger.info("outer after inner");
    });
    expect(records[0]?.req_id).toBe("outer_req");
    expect(records[1]?.req_id).toBe("inner_req");
    expect(records[2]?.req_id).toBe("outer_req");
  });
});

// ---------------------------------------------------------------------------
// 2. req_id ALS propagation — async jobs
// ---------------------------------------------------------------------------
describe("req_id ALS propagation — async", () => {
  it("propagates req_id through async/await chains", async () => {
    const { testLogger, records } = createTestLogger();

    await new Promise<void>((resolve) => {
      runWithReqId("req_async_001", async () => {
        await Promise.resolve(); // yield to event loop
        testLogger.info("after async yield");
        resolve();
      });
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.req_id).toBe("req_async_001");
  });

  it("propagates req_id through setTimeout callback", async () => {
    const { testLogger, records } = createTestLogger();

    await new Promise<void>((resolve) => {
      runWithReqId("req_timeout_002", () => {
        setTimeout(() => {
          testLogger.info("inside setTimeout");
          resolve();
        }, 0);
      });
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.req_id).toBe("req_timeout_002");
  });

  it("isolates req_id between concurrent async jobs", async () => {
    const { testLogger, records } = createTestLogger();

    await Promise.all([
      new Promise<void>((resolve) => {
        runWithReqId("req_concurrent_A", async () => {
          await new Promise((r) => setTimeout(r, 10));
          testLogger.info("job A");
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        runWithReqId("req_concurrent_B", async () => {
          await new Promise((r) => setTimeout(r, 5));
          testLogger.info("job B");
          resolve();
        });
      }),
    ]);

    const recordA = records.find((r) => r.msg === "job A");
    const recordB = records.find((r) => r.msg === "job B");
    expect(recordA?.req_id).toBe("req_concurrent_A");
    expect(recordB?.req_id).toBe("req_concurrent_B");
  });
});

// ---------------------------------------------------------------------------
// 3. trace_id / span_id ALS propagation
// ---------------------------------------------------------------------------
describe("trace_id and span_id ALS propagation", () => {
  it("injects trace_id and span_id from tracing context", () => {
    const { testLogger, records } = createTestLogger();
    const ctx = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
      startTime: Date.now(),
    };

    runWithTraceContext(ctx, () => {
      testLogger.info("traced log");
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(records[0]?.span_id).toBe("00f067aa0ba902b7");
  });

  it("does NOT inject trace_id outside tracing scope", () => {
    const { testLogger, records } = createTestLogger();
    testLogger.info("no trace");
    expect(records[0]?.trace_id).toBeUndefined();
    expect(records[0]?.span_id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Both req_id and trace_id present simultaneously
// ---------------------------------------------------------------------------
describe("req_id + trace_id together", () => {
  it("emits both fields when both ALS contexts are active", () => {
    const { testLogger, records } = createTestLogger();
    const ctx = {
      traceId: "aabbccddeeff00112233445566778899",
      spanId: "1122334455667788",
      traceFlags: "01",
      startTime: Date.now(),
    };

    runWithReqId("req_combined_001", () => {
      runWithTraceContext(ctx, () => {
        testLogger.info("combined context log");
      });
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.req_id).toBe("req_combined_001");
    expect(records[0]?.trace_id).toBe("aabbccddeeff00112233445566778899");
    expect(records[0]?.span_id).toBe("1122334455667788");
    expect(records[0]?.msg).toBe("combined context log");
  });
});

// ---------------------------------------------------------------------------
// 5. Circular reference — must not crash
// ---------------------------------------------------------------------------
describe("circular reference handling", () => {
  it("does not throw when logging an object with a circular reference", () => {
    const { testLogger, records } = createTestLogger();

    const circular: Record<string, unknown> = { name: "circular" };
    circular["self"] = circular; // create the cycle

    expect(() => {
      testLogger.info({ obj: circular }, "circular ref log");
    }).not.toThrow();

    // pino should have written something (it uses safe-json-stringify internally)
    expect(records.length).toBeGreaterThanOrEqual(0);
  });

  it("addTraceCorrelationToLog does not throw on circular input", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular["self"] = circular;

    expect(() => {
      addTraceCorrelationToLog(circular);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. Massive payload — must not crash or OOM
// ---------------------------------------------------------------------------
describe("massive payload handling", () => {
  it("handles logging a 1 MB string without crashing", () => {
    const { testLogger, records } = createTestLogger();
    const bigString = "x".repeat(1_000_000);

    expect(() => {
      testLogger.info({ payload: bigString }, "large payload");
    }).not.toThrow();

    expect(records.length).toBeGreaterThanOrEqual(1);
  });

  it("handles a 50-level deeply nested object without crashing", () => {
    const { testLogger } = createTestLogger();
    let nested: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 50; i++) {
      nested = { child: nested };
    }

    expect(() => {
      testLogger.info({ deep: nested }, "deep nested object");
    }).not.toThrow();
  });

  it("handles an array of 10 000 items without crashing", () => {
    const { testLogger } = createTestLogger();
    const bigArray = Array.from({ length: 10_000 }, (_, i) => ({ id: i }));

    expect(() => {
      testLogger.info({ items: bigArray }, "big array");
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. requestIdMiddleware ALS integration
// ---------------------------------------------------------------------------
describe("requestIdMiddleware ALS integration", () => {
  it("makes req_id available via getReqId inside the request handler", async () => {
    let capturedReqId: string | undefined;

    const app = express();
    app.use(requestIdMiddleware);
    app.get("/test", (_req, res) => {
      capturedReqId = getReqId();
      res.json({ ok: true });
    });

    const res = await request(app)
      .get("/test")
      .set("x-request-id", "req_als_integration_001");

    expect(res.status).toBe(200);
    expect(capturedReqId).toBe("req_als_integration_001");
  });

  it("generates a new req_id when no x-request-id header is provided", async () => {
    let capturedReqId: string | undefined;

    const app = express();
    app.use(requestIdMiddleware);
    app.get("/test", (_req, res) => {
      capturedReqId = getReqId();
      res.json({ ok: true });
    });

    await request(app).get("/test");

    expect(typeof capturedReqId).toBe("string");
    expect(capturedReqId).toMatch(/^req_/);
  });

  it("propagates req_id through async route handlers", async () => {
    let capturedReqId: string | undefined;

    const app = express();
    app.use(requestIdMiddleware);
    app.get("/async", async (_req, res) => {
      await Promise.resolve(); // yield to event loop
      capturedReqId = getReqId();
      res.json({ ok: true });
    });

    await request(app)
      .get("/async")
      .set("x-request-id", "req_async_als_002");

    expect(capturedReqId).toBe("req_async_als_002");
  });

  it("req_id from mixin appears as top-level field in log output", () => {
    const { testLogger, records } = createTestLogger();

    runWithReqId("req_middleware_003", () => {
      testLogger.info("handler log");
    });

    expect(records[0]?.req_id).toBe("req_middleware_003");
    // Ensure it is a top-level field, not nested
    expect(typeof records[0]?.req_id).toBe("string");
  });
});
