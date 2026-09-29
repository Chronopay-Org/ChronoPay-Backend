import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { createContentNegotiationMiddleware } from "../contentNegotiation.js";

jest.unstable_mockModule("../rateLimitStore.js", () => ({
  rateLimitRedisStore: {
    async incr() {
      return 1;
    },
    async decrement() {},
    async resetKey() {},
  },
}));

let createApp: typeof import("../../app.js").createApp;

beforeAll(async () => {
  ({ createApp } = await import("../../app.js"));
});

function createHarness(options?: { excludePaths?: string[] }) {
  const app = express();

  app.use(createContentNegotiationMiddleware(options));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post("/echo", (req, res) => {
    res.status(200).json({ body: req.body ?? null });
  });

  app.post("/webhooks/stripe/events", (_req, res) => {
    res.status(200).json({ bypassed: true });
  });

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const error = err as {
        statusCode?: number;
        code?: string;
        message?: string;
      };
      res.status(error.statusCode ?? 500).json({
        success: false,
        code: error.code,
        error: error.message,
      });
    },
  );

  return app;
}

describe("content negotiation middleware", () => {
  it("rejects POST requests with unsupported content types before JSON parsing", async () => {
    const res = await request(createHarness())
      .post("/echo")
      .set("Content-Type", "text/plain")
      .set("Accept", "application/json")
      .send("not json");

    expect(res.status).toBe(415);
    expect(res.body).toMatchObject({
      success: false,
      code: "UNSUPPORTED_MEDIA_TYPE",
      error: "Content-Type must be application/json",
    });
  });

  it("rejects POST requests that omit Content-Type", async () => {
    const res = await request(createHarness())
      .post("/echo")
      .set("Accept", "application/json");

    expect(res.status).toBe(415);
    expect(res.body.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("allows JSON content types with charset parameters", async () => {
    const res = await request(createHarness())
      .post("/echo")
      .set("Content-Type", "application/json; charset=utf-8")
      .set("Accept", "application/json")
      .send(JSON.stringify({ invoiceId: "inv_123" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ body: { invoiceId: "inv_123" } });
  });

  it("allows wildcard Accept headers", async () => {
    const res = await request(createHarness())
      .post("/echo")
      .set("Content-Type", "application/json")
      .set("Accept", "*/*")
      .send({ ok: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ body: { ok: true } });
  });

  it("rejects body requests that do not accept JSON responses", async () => {
    const res = await request(createHarness())
      .post("/echo")
      .set("Content-Type", "application/json")
      .set("Accept", "text/html")
      .send({ ok: true });

    expect(res.status).toBe(406);
    expect(res.body).toMatchObject({
      success: false,
      code: "NOT_ACCEPTABLE",
      error: "Accept header must include application/json",
    });
  });

  it("does not require JSON Accept headers for GET requests", async () => {
    const res = await request(createHarness())
      .get("/health")
      .set("Accept", "text/html");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("bypasses configured excluded path prefixes", async () => {
    const res = await request(createHarness({ excludePaths: ["/webhooks"] }))
      .post("/webhooks/stripe/events")
      .set("Content-Type", "text/plain")
      .set("Accept", "text/html")
      .send("raw webhook body");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bypassed: true });
  });

  it("is wired before JSON parsing in the real app factory", async () => {
    const rejected = await request(createApp({ enableDocs: false }))
      .post("/api/v1/slots")
      .set("Content-Type", "text/plain")
      .set("Accept", "application/json")
      .send("not json");

    expect(rejected.status).toBe(415);
    expect(rejected.body.code).toBe("UNSUPPORTED_MEDIA_TYPE");

    const excluded = await request(
      createApp({
        enableDocs: false,
        contentNegotiationExcludePaths: ["/api/v1/slots"],
      }),
    )
      .post("/api/v1/slots")
      .set("Content-Type", "text/plain")
      .set("Accept", "text/html")
      .send("not json");

    // The exclusion must remove the 415: with a text/plain body and an
    // Accept that cannot accept JSON, a 415 here would mean the excluded
    // prefix was ignored. The request then proceeds to the next wall in the
    // chain (authentication), which is why 401 — not the historical 400 — is
    // the expected non-415 outcome on the current app factory.
    expect(excluded.status).not.toBe(415);
    expect(excluded.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit-level contract (issue #1103): direct invocation against stubbed
// req/res/next so every branch is observable without an app factory.
// ─────────────────────────────────────────────────────────────────────────────

describe("createContentNegotiationMiddleware (unit contract)", () => {
  type Handled = { status?: number; payload?: unknown };

  function stubs(
    {
      method = "GET",
      url = "/",
      headers = {},
      excludePaths,
    }: {
      method?: string;
      url?: string;
      headers?: Record<string, string | undefined>;
      excludePaths?: string[];
    } = {},
  ) {
    const middleware = createContentNegotiationMiddleware({ excludePaths });
    const req = {
      method,
      url,
      originalUrl: url,
      headers,
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as express.Request;
    const handled: Handled = {};
    const res = {
      statusCode: 200,
      status(this: { statusCode: number }, code: number) {
        this.statusCode = code;
        handled.status = code;
        return this;
      },
      json(payload: unknown) {
        handled.payload = payload;
        return this;
      },
    } as unknown as express.Response;
    const next = jest.fn();
    return { middleware, req, res, next, handled };
  }

  it("returns a reusable middleware and never throws at construction time", () => {
    expect(() => createContentNegotiationMiddleware()).not.toThrow();
    expect(() => createContentNegotiationMiddleware({})).not.toThrow();
    expect(() =>
      createContentNegotiationMiddleware({ excludePaths: [] }),
    ).not.toThrow();
    expect(typeof createContentNegotiationMiddleware()).toBe("function");
  });

  it("treats missing options as an empty exclusion list", () => {
    const { middleware, req, res, next } = stubs({
      method: "POST",
      headers: { "content-type": "text/plain" },
    });
    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    const error = next.mock.calls[0][0] as express.ErrorRequestHandler extends never
      ? never
      : { statusCode: number; code: string };
    expect((error as { statusCode: number }).statusCode).toBe(415);
  });

  it.each([
    ["OPTIONS", false],
    ["HEAD", false],
    ["GET", false],
    ["DELETE", false],
    ["POST", true],
    ["PUT", true],
    ["PATCH", true],
  ] as const)("method %s: content-type enforced = %s", (method, enforced) => {
    const { middleware, req, res, next } = stubs({
      method,
      headers: { "content-type": "text/plain", accept: "application/json" },
    });
    middleware(req, res, next);
    if (enforced) {
      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 415, code: "UNSUPPORTED_MEDIA_TYPE" }),
      );
    } else {
      expect(next).toHaveBeenCalledWith();
    }
  });

  it.each([
    ["application/json", true],
    ["application/json; charset=utf-8", true],
    ["APPLICATION/JSON", false], // media types are case-sensitive per RFC 7231
    ["application/JSON; charset=UTF-8", false],
    ["text/json", false],
    ["application/xml", false],
    ["json", false],
    ["", false],
  ])("content-type %p: accepted = %p", (contentType, accepted) => {
    const { middleware, req, res, next } = stubs({
      method: "POST",
      headers: { "content-type": contentType, accept: "application/json" },
    });
    middleware(req, res, next);
    if (accepted) {
      expect(next).toHaveBeenCalledWith();
    } else {
      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 415, code: "UNSUPPORTED_MEDIA_TYPE" }),
      );
    }
  });

  it("rejects a POST with no content-type header at all", () => {
    const { middleware, req, res, next } = stubs({
      method: "POST",
      headers: { accept: "application/json" },
    });
    middleware(req, res, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 415,
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Content-Type must be application/json",
      }),
    );
  });

  it.each([
    [undefined, true], // missing Accept accepts everything
    ["application/json", true],
    ["application/json; q=0.8, text/html", true],
    ["*/*", true],
    ["text/*", false], // sub-range wildcards do NOT imply JSON
    ["text/html", false],
    ["", true], // empty string is falsy: treated as "no Accept header"
  ] as const)("accept %p: accepted = %p", (accept, accepted) => {
    const { middleware, req, res, next } = stubs({
      method: "POST",
      headers: { "content-type": "application/json", accept } as Record<
        string,
        string | undefined
      >,
    });
    middleware(req, res, next);
    if (accepted) {
      expect(next).toHaveBeenCalledWith();
    } else {
      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 406, code: "NOT_ACCEPTABLE" }),
      );
    }
  });

  it("does not enforce Accept on GET and DELETE even when it cannot accept JSON", () => {
    for (const method of ["GET", "DELETE"]) {
      const { middleware, req, res, next } = stubs({
        method,
        headers: { accept: "text/html" },
      });
      middleware(req, res, next);
      expect(next).toHaveBeenCalledWith();
    }
  });

  it("enforces Accept on POST/PUT/PATCH but content-type first: 415 wins over 406", () => {
    const { middleware, req, res, next } = stubs({
      method: "PUT",
      headers: { "content-type": "text/plain", accept: "text/html" },
    });
    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 415 }),
    );
  });

  it("exclusion paths match by prefix and are evaluated before method checks", () => {
    // Excluded path bypasses both checks even for a body method with bad headers.
    const excluded = stubs({
      method: "POST",
      url: "/webhooks/stripe/events",
      headers: { "content-type": "text/plain", accept: "text/html" },
      excludePaths: ["/webhooks"],
    });
    excluded.middleware(excluded.req, excluded.res, excluded.next);
    expect(excluded.next).toHaveBeenCalledWith();

    // Non-excluded prefix still enforces both checks.
    const notExcluded = stubs({
      method: "POST",
      url: "/api/v1/checkout/sessions",
      headers: { "content-type": "text/plain", accept: "text/html" },
      excludePaths: ["/webhooks"],
    });
    notExcluded.middleware(notExcluded.req, notExcluded.res, notExcluded.next);
    expect(notExcluded.next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 415 }),
    );
  });

  it("treats an empty excludePaths option identically to no option", () => {
    const { middleware, req, res, next } = stubs({
      method: "POST",
      url: "/webhooks/x",
      headers: { "content-type": "text/plain" },
      excludePaths: [],
    });
    middleware(req, res, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 415 }),
    );
  });

  it("uses originalUrl when present, falling back to url", () => {
    // originalUrl present: prefix matches.
    const withOriginal = stubs({
      method: "POST",
      url: "/webhooks/deep",
      headers: { "content-type": "text/plain" },
      excludePaths: ["/webhooks"],
    });
    withOriginal.middleware(withOriginal.req, withOriginal.res, withOriginal.next);
    expect(withOriginal.next).toHaveBeenCalledWith();

    // originalUrl missing: url is used instead.
    const middleware = createContentNegotiationMiddleware({
      excludePaths: ["/webhooks"],
    });
    const req = {
      method: "POST",
      url: "/webhooks/deep",
      headers: { "content-type": "text/plain" },
    } as unknown as express.Request;
    const res = {} as express.Response;
    const next = jest.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("emits errors with the ContentNegotiationError contract (isAppError-compatible)", async () => {
    const { middleware, req, res, next } = stubs({
      method: "POST",
      headers: { "content-type": "text/plain" },
    });
    middleware(req, res, next);
    const error = next.mock.calls[0][0] as { statusCode: number; code: string };
    expect(error).toBeInstanceOf(Error);
    expect(error.statusCode).toBe(415);
    expect(error.code).toBe("UNSUPPORTED_MEDIA_TYPE");

    const { middleware: m2, req: r2, res: r2s, next: n2 } = stubs({
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/html" },
    });
    m2(r2, r2s, n2);
    const notAcceptable = n2.mock.calls[0][0] as { statusCode: number; code: string };
    expect(notAcceptable).toBeInstanceOf(Error);
    expect(notAcceptable.statusCode).toBe(406);
    expect(notAcceptable.code).toBe("NOT_ACCEPTABLE");
  });

  it("does not short-circuit valid traffic: OPTIONS/HEAD with hostile headers pass", () => {
    for (const method of ["OPTIONS", "HEAD"]) {
      const { middleware, req, res, next } = stubs({
        method,
        headers: { "content-type": "text/plain", accept: "text/html" },
      });
      middleware(req, res, next);
      expect(next).toHaveBeenCalledWith();
    }
  });
});
