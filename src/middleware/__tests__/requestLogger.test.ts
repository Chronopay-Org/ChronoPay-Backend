import request from "supertest";
import express from "express";

const originalEnv = process.env.NODE_ENV;

describe("Request logger trace correlation", () => {
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("should attach traceId and spanId to request logs on every emitted log line", async () => {
    process.env.NODE_ENV = "production";

    const requestLogger = await import("../requestLogger.js");
    const tracing = await import("../../tracing/middleware.js");

    const logs: any[] = [];

    const app = express();
    app.use(tracing.tracingMiddleware);
    app.use(requestLogger.createRequestLogger());

    app.get("/test", (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: any) => {
      const text = typeof chunk === "string" ? chunk : chunk?.toString?.("utf8");
      if (typeof text === "string") {
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            logs.push(JSON.parse(line));
          } catch {
            // ignore non-JSON lines
          }
        }
      }
      return true;
    }) as typeof process.stdout.write;

    try {
      const res = await request(app).get("/test");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const requestLogs = logs.filter((entry) => entry.msg?.includes("completed in"));
      expect(requestLogs.length).toBeGreaterThanOrEqual(1);
      for (const log of requestLogs) {
        expect(log.traceId).toBeDefined();
        expect(log.spanId).toBeDefined();
        expect(log.traceId).toMatch(/^[0-9a-f]{32}$/i);
        expect(log.spanId).toMatch(/^[0-9a-f]{16}$/i);
      }
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});
