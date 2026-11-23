import { beforeEach, afterAll, describe, expect, it, jest } from "@jest/globals";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { Request } from "express";
import type { Options as PinoHttpOptions } from "pino-http";

let captured: PinoHttpOptions | undefined;
const getTraceContext = jest.fn<() => { traceId: string; spanId: string } | undefined>();
jest.unstable_mockModule("pino-http", () => ({
  pinoHttp: (options: PinoHttpOptions) => {
    captured = options;
    return () => undefined;
  },
}));
jest.unstable_mockModule("../../utils/logger.js", () => ({ logger: {} }));
jest.unstable_mockModule("../../tracing/context.js", () => ({ getTraceContext }));
const { createRequestLogger } = await import("../requestLogger.js");
const originalEnv = process.env.NODE_ENV;
afterAll(() => {
  if (originalEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnv;
});
beforeEach(() => {
  process.env.NODE_ENV = "production";
  captured = undefined;
  getTraceContext.mockReset();
  createRequestLogger();
});

function props(req: IncomingMessage): object {
  const callback = captured?.customProps;
  if (!callback) throw new Error("Expected pino-http customProps callback");
  return callback(req, new ServerResponse(req));
}
function expressRequest(identity: { userId?: string; apiKeyId?: string } = {}): Request {
  const req = new IncomingMessage(new Socket()) as Request;
  const headers: Record<string, string> = {
    "user-agent": "ChronoPay regression test",
    "x-api-key-id": "header-key",
  };
  return Object.assign(req, {
    requestId: "request-1467",
    method: "POST",
    route: { path: "/orders/:orderId" },
    ip: "203.0.113.7",
    logContext: identity,
    get: (name: string) => headers[name.toLowerCase()],
    header: (name: string) => headers[name.toLowerCase()],
  });
}

describe("pino-http customProps", () => {
  it("preserves the exact Express log fields with identity and trace context", () => {
    getTraceContext.mockReturnValue({ traceId: "a".repeat(32), spanId: "b".repeat(16) });
    expect(props(expressRequest({ userId: "buyer-1" }))).toEqual({
      requestId: "request-1467",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      route: "/orders/:REDACTED",
      method: "POST",
      userId: "buyer-1",
      apiKeyId: undefined,
      ip: "203.0.113.7",
      userAgent: "ChronoPay regression test",
    });
  });
  it("preserves the request-ID trace fallback and API-key identity", () => {
    expect(props(expressRequest({ apiKeyId: "context-key" }))).toEqual({
      requestId: "request-1467",
      traceId: "request-1467",
      spanId: undefined,
      route: "/orders/:REDACTED",
      method: "POST",
      userId: undefined,
      apiKeyId: "context-key",
      ip: "203.0.113.7",
      userAgent: "ChronoPay regression test",
    });
  });
  it("retains API-key header extraction when no identity was attached", () => {
    expect(props(expressRequest())).toMatchObject({
      apiKeyId: "header-key",
      traceId: "request-1467",
    });
  });
  it("accepts a plain IncomingMessage without calling Express helpers", () => {
    expect(props(new IncomingMessage(new Socket()))).toEqual({});
  });
  it("rejects non-function or incomplete Express helper shapes safely", () => {
    const req = new IncomingMessage(new Socket());
    expect(props(Object.assign(req, { get: "invalid", header: () => undefined }))).toEqual({});
    expect(
      props(Object.assign(new IncomingMessage(new Socket()), { get: () => undefined })),
    ).toEqual({});
  });
});
