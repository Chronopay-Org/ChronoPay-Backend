/**
 * validation.test.ts
 *
 * Focused behaviour coverage for src/middleware/validation.ts — the module that
 * owns the `ValidationDetail` / `ValidationErrorResponse` contract and the two
 * validation middleware factories.
 *
 * Exports under test
 * ──────────────────
 *   ValidationDetail        – { path, rule, message } failure record
 *   ValidationErrorResponse – { success: false, code, error, details } envelope
 *   validateRequiredFields  – presence / non-empty middleware (body|query|params)
 *   validateBody            – Zod middleware: strips unknown keys, sorts details
 *
 * Every case mounts the middleware on a throwaway Express app and asserts the
 * wire response, so the public contract — not the internals — is what is
 * exercised. The terminal route handler is a mock, which makes the
 * "request passed through" vs "request rejected" state transition observable.
 */

import { describe, it, expect, jest } from "@jest/globals";
import request from "supertest";
import express, { type Request, type Response } from "express";
import { z, ZodError } from "zod";
import {
  validateBody,
  validateRequiredFields,
  type ValidationDetail,
  type ValidationErrorResponse,
} from "../validation.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** `validateRequiredFields`'s second parameter type (the source type is not exported). */
type RequiredTarget = Parameters<typeof validateRequiredFields>[1];

/** The schema parameter type accepted by `validateBody`. */
type BodySchema = Parameters<typeof validateBody>[0];

/** A successful terminal handler that records whether it ran. */
function terminalHandler() {
  return jest.fn((_req: Request, res: Response) => {
    res.status(200).json({ success: true, reached: true });
  });
}

/**
 * Drop the non-deterministic `timestamp` that `sendError` stamps on every
 * envelope, so two otherwise identical responses can be compared field by field.
 */
function withoutTimestamp(body: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...body };
  delete clone.timestamp;
  return clone;
}

/**
 * Mount `validateRequiredFields` on a throwaway app (always POST, so a single
 * helper covers body, query and params targets).
 */
function appWithRequiredFields(
  requiredFields: string[],
  target: RequiredTarget = "body",
  path = "/test",
) {
  const app = express();
  app.use(express.json());
  const handler = terminalHandler();
  app.post(path, validateRequiredFields(requiredFields, target), handler);
  return { app, handler };
}

/**
 * Mount `validateBody` on a throwaway app. `status` mirrors the optional
 * second argument of the factory (default 400).
 */
function appWithBody(schema: BodySchema, status?: number) {
  const app = express();
  app.use(express.json());
  const handler = terminalHandler();
  app.post("/test", validateBody(schema, status), handler);
  return { app, handler };
}

/**
 * Mount `validateRequiredFields` behind a shim that forces `req.body` to an
 * arbitrary value, letting us exercise the "not an object" guard.
 */
function appWithRawBody(value: unknown, requiredFields: string[] = ["email"]) {
  const app = express();
  const handler = terminalHandler();
  app.use((req, _res, next) => {
    (req as Request & { body: unknown }).body = value;
    next();
  });
  app.post("/test", validateRequiredFields(requiredFields), handler);
  return { app, handler };
}

/**
 * Mount `validateRequiredFields` with a target whose property access throws,
 * forcing the middleware's defensive catch instead of a validation failure.
 */
function appWithHostileBody(requiredFields: string[] = ["email"]) {
  const app = express();
  const handler = terminalHandler();
  app.use((req, _res, next) => {
    (req as Request & { body: unknown }).body = new Proxy(
      {},
      {
        get() {
          throw new Error("kaboom: secret internals");
        },
      },
    );
    next();
  });
  app.post("/test", validateRequiredFields(requiredFields), handler);
  return { app, handler };
}

/**
 * Assert the wire shape of the `details` array: a non-empty list of exactly
 * `{ path, rule, message }` records (no raw field values, no extra keys).
 */
function expectDetailShape(details: unknown) {
  expect(Array.isArray(details)).toBe(true);
  for (const detail of details as ValidationDetail[]) {
    expect(Object.keys(detail).sort()).toEqual(["message", "path", "rule"]);
    expect(typeof detail.path).toBe("string");
    expect(typeof detail.rule).toBe("string");
    expect(typeof detail.message).toBe("string");
    expect(detail.message.length).toBeGreaterThan(0);
  }
}

/** A schema-like stub whose `safeParse` throws — exercises the factory's catch. */
function throwingSchema(error: unknown): BodySchema {
  return {
    safeParse: () => {
      throw error;
    },
  } as unknown as BodySchema;
}

// ─────────────────────────────────────────────────────────────────────────────
// ValidationDetail / ValidationErrorResponse — the public contract
// ─────────────────────────────────────────────────────────────────────────────

describe("ValidationDetail / ValidationErrorResponse contract", () => {
  it("declares a ValidationDetail as exactly { path, rule, message }", () => {
    const detail: ValidationDetail = {
      path: "startTime",
      rule: "required",
      message: "Required",
    };
    expect(Object.keys(detail).sort()).toEqual(["message", "path", "rule"]);
    expect(Object.values(detail)).toEqual(["startTime", "required", "Required"]);
  });

  it("declares the ValidationErrorResponse envelope with success:false and a code", () => {
    const envelope: ValidationErrorResponse = {
      success: false,
      code: "VALIDATION_ERROR",
      error: "Required",
      details: [{ path: "startTime", rule: "required", message: "Required" }],
    };
    expect(envelope.success).toBe(false);
    expect(envelope.code).toBe("VALIDATION_ERROR");
    expect(envelope.details).toHaveLength(1);
  });

  it("emits an envelope whose keys are exactly { code, details, error, success }", async () => {
    const { app } = appWithBody(z.object({ email: z.string().min(1) }));
    const res = await request(app).post("/test").send({});

    expect(Object.keys(res.body).sort()).toEqual(["code", "details", "error", "success"]);
    expect(res.body).toMatchObject({ success: false, code: "VALIDATION_ERROR" });
    expectDetailShape(res.body.details);
  });

  it("never echoes the raw submitted value back to the client", async () => {
    const { app } = appWithBody(z.object({ email: z.string().min(1) }));
    const res = await request(app).post("/test").send({ email: 987654321 });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("987654321");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateRequiredFields
// ─────────────────────────────────────────────────────────────────────────────

describe("validateRequiredFields", () => {
  describe("success path", () => {
    it("lets the request through when every field is present and non-empty", async () => {
      const { app, handler } = appWithRequiredFields(["email", "password"]);
      const res = await request(app)
        .post("/test")
        .send({ email: "a@example.com", password: "s3cret" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, reached: true });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("accepts falsy-but-present values (0 and false are not missing)", async () => {
      const { app, handler } = appWithRequiredFields(["count", "enabled"]);
      const res = await request(app).post("/test").send({ count: 0, enabled: false });

      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("sends no error envelope on the success path", async () => {
      const { app } = appWithRequiredFields(["email"]);
      const res = await request(app).post("/test").send({ email: "a@example.com" });

      expect(res.body.code).toBeUndefined();
      expect(res.body.details).toBeUndefined();
    });
  });

  describe("failure path — missing, null or empty fields", () => {
    it("rejects a missing field and never reaches the handler", async () => {
      const { app, handler } = appWithRequiredFields(["email"]);
      const res = await request(app).post("/test").send({});

      expect(res.status).toBe(400);
      expect(handler).not.toHaveBeenCalled();
      expect(res.body).toMatchObject({
        success: false,
        code: "MISSING_REQUIRED_FIELD",
        message: "Missing required field: email",
        error: "Missing required field: email",
        details: { field: "email" },
      });
    });

    it("treats an empty string as missing", async () => {
      const { app, handler } = appWithRequiredFields(["email"]);
      const res = await request(app).post("/test").send({ email: "" });

      expect(res.status).toBe(400);
      expect(handler).not.toHaveBeenCalled();
      expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
      expect(res.body.details).toEqual({ field: "email" });
    });

    it("treats null as missing", async () => {
      const { app } = appWithRequiredFields(["email"]);
      const res = await request(app).post("/test").send({ email: null });

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual({ field: "email" });
    });

    it("treats an explicit undefined value as missing", async () => {
      const { app } = appWithRawBody({ email: undefined });
      const res = await request(app).post("/test");

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual({ field: "email" });
    });

    it("names the first failing field in declared order", async () => {
      const { app } = appWithRequiredFields(["alpha", "beta", "gamma"]);
      const res = await request(app).post("/test").send({ gamma: "g" });

      expect(res.body.details).toEqual({ field: "alpha" });
      expect(res.body.error).toBe("Missing required field: alpha");
    });

    it("is deterministic: identical requests produce identical envelopes", async () => {
      const { app } = appWithRequiredFields(["email"]);
      const first = await request(app).post("/test").send({});
      const second = await request(app).post("/test").send({});

      expect(second.status).toBe(first.status);
      expect(withoutTimestamp(second.body)).toEqual(withoutTimestamp(first.body));
    });
  });

  describe("failure path — target is not an object", () => {
    it("rejects a string body with BAD_REQUEST", async () => {
      const { app, handler } = appWithRawBody("not-an-object");
      const res = await request(app).post("/test");

      expect(res.status).toBe(400);
      expect(handler).not.toHaveBeenCalled();
      expect(res.body).toMatchObject({
        success: false,
        code: "BAD_REQUEST",
        error: "Request body is missing or invalid",
      });
    });

    it("rejects a null body with BAD_REQUEST", async () => {
      const { app, handler } = appWithRawBody(null);
      const res = await request(app).post("/test");

      expect(res.status).toBe(400);
      expect(handler).not.toHaveBeenCalled();
      expect(res.body.code).toBe("BAD_REQUEST");
    });

    it("rejects an absent body with BAD_REQUEST", async () => {
      const { app, handler } = appWithRawBody(undefined);
      const res = await request(app).post("/test");

      expect(res.status).toBe(400);
      expect(handler).not.toHaveBeenCalled();
      expect(res.body.error).toBe("Request body is missing or invalid");
    });
  });

  describe("target selection (body | query | params)", () => {
    it('reads query parameters when target is "query"', async () => {
      const { app, handler } = appWithRequiredFields(["page"], "query");

      const ok = await request(app).post("/test?page=1");
      expect(ok.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);

      const bad = await request(app).post("/test");
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("MISSING_REQUIRED_FIELD");
      expect(bad.body.details).toEqual({ field: "page" });
    });

    it('reads route parameters when target is "params"', async () => {
      const success = appWithRequiredFields(["slotId"], "params", "/test/:slotId");
      const ok = await request(success.app).post("/test/slot-1");
      expect(ok.status).toBe(200);
      expect(success.handler).toHaveBeenCalledTimes(1);

      // A route without the declared parameter leaves `req.params` empty, so the
      // declared field counts as missing and the request never reaches the handler.
      const failure = appWithRequiredFields(["slotId"], "params");
      const bad = await request(failure.app).post("/test");
      expect(bad.status).toBe(400);
      expect(bad.body.details).toEqual({ field: "slotId" });
      expect(failure.handler).not.toHaveBeenCalled();
    });

    it("defaults to the body when no target is given", async () => {
      const { app, handler } = appWithRequiredFields(["email"]);
      const res = await request(app).post("/test").query({ email: "a@example.com" });

      expect(res.status).toBe(400);
      expect(handler).not.toHaveBeenCalled();
      expect(res.body.details).toEqual({ field: "email" });
    });
  });

  describe("internal failures", () => {
    it("returns a generic 500 when reading the target throws", async () => {
      const { app, handler } = appWithHostileBody();
      const res = await request(app).post("/test");

      expect(res.status).toBe(500);
      expect(handler).not.toHaveBeenCalled();
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("INTERNAL_ERROR");
      expect(res.body.error).toBe("Validation middleware error");
      expect(JSON.stringify(res.body)).not.toContain("kaboom");
    });

    it("returns a generic 500 when a query target access throws", async () => {
      const app = express();
      const handler = terminalHandler();
      app.use((req, _res, next) => {
        (req as Request & { query: unknown }).query = new Proxy(
          {},
          {
            get() {
              throw new Error("kaboom: secret internals");
            },
          },
        );
        next();
      });
      app.get("/test", validateRequiredFields(["page"], "query"), handler);

      const res = await request(app).get("/test");

      expect(res.status).toBe(500);
      expect(handler).not.toHaveBeenCalled();
      expect(res.body.code).toBe("INTERNAL_ERROR");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateBody
// ─────────────────────────────────────────────────────────────────────────────

describe("validateBody", () => {
  describe("success path", () => {
    it("forwards a valid body and calls next exactly once", async () => {
      const { app, handler } = appWithBody(z.object({ email: z.string().email() }));
      const res = await request(app).post("/test").send({ email: "a@example.com" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, reached: true });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("replaces req.body with the parsed output", async () => {
      const app = express();
      app.use(express.json());
      app.post("/test", validateBody(z.object({ count: z.coerce.number() })), (req, res) => {
        res.status(200).json({ body: req.body });
      });

      const res = await request(app).post("/test").send({ count: "42" });

      expect(res.status).toBe(200);
      expect(res.body.body).toEqual({ count: 42 });
    });

    it("strips unknown fields instead of forwarding them", async () => {
      const app = express();
      app.use(express.json());
      app.post("/test", validateBody(z.object({ email: z.string().email() })), (req, res) => {
        res.status(200).json({ keys: Object.keys(req.body as Record<string, unknown>).sort() });
      });

      const res = await request(app).post("/test").send({ email: "a@example.com", isAdmin: true });

      expect(res.status).toBe(200);
      expect(res.body.keys).toEqual(["email"]);
    });
  });

  describe("representative invalid inputs", () => {
    it("rejects a wrong-typed field and never reaches the handler", async () => {
      const { app, handler } = appWithBody(z.object({ email: z.string().min(1) }));
      const res = await request(app).post("/test").send({ email: 123456789 });

      expect(res.status).toBe(400);
      expect(handler).not.toHaveBeenCalled();
      expect(res.body).toMatchObject({ success: false, code: "VALIDATION_ERROR" });
      expectDetailShape(res.body.details);
      expect(res.body.details[0]).toMatchObject({ path: "email", rule: "invalid_type" });
    });

    it('falls back to "body" when the failing issue has an empty path', async () => {
      const { app } = appWithBody(z.string());
      const res = await request(app).post("/test").send({ email: "a@example.com" });

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([
        { path: "body", rule: "invalid_type", message: expect.any(String) },
      ]);
    });

    it("joins nested issue paths with dots", async () => {
      const { app } = appWithBody(z.object({ user: z.object({ email: z.string().email() }) }));
      const res = await request(app)
        .post("/test")
        .send({ user: { email: "not-an-email" } });

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([
        { path: "user.email", rule: "invalid_string", message: expect.any(String) },
      ]);
    });
  });

  describe("deterministic detail ordering", () => {
    it("sorts details by path ASC regardless of issue order", async () => {
      const { app } = appWithBody(
        z.object({ zebra: z.number().min(100), alpha: z.number(), mike: z.number() }),
      );
      const res = await request(app).post("/test").send({ zebra: 1, alpha: "a", mike: "m" });

      expect(res.status).toBe(400);
      expect(res.body.details.map((d: ValidationDetail) => d.path)).toEqual([
        "alpha",
        "mike",
        "zebra",
      ]);
      // The headline keeps request order (the first issue Zod reports) while
      // `details` is sorted — the two are intentionally allowed to differ.
      const zebra = res.body.details.find((d: ValidationDetail) => d.path === "zebra");
      expect(res.body.error).toBe(zebra.message);
    });

    it("breaks path ties by rule ASC", async () => {
      // `min` and `email` both fail on the same field and Zod reports them in
      // declaration order (too_small first), so an invalid_string-first result
      // proves the secondary sort key is applied.
      const { app } = appWithBody(z.object({ email: z.string().min(20).email() }));
      const res = await request(app).post("/test").send({ email: "abc" });

      const rules = res.body.details.map((d: ValidationDetail) => d.rule);
      expect(rules).toContain("too_small");
      expect(rules).toContain("invalid_string");
      expect(rules[0]).toBe("invalid_string");
    });

    it("is deterministic: repeated identical requests are byte-identical", async () => {
      const { app } = appWithBody(z.object({ zebra: z.number(), alpha: z.number() }));
      const payload = { zebra: "z", alpha: "a" };

      const first = await request(app).post("/test").send(payload);
      const second = await request(app).post("/test").send(payload);

      expect(second.status).toBe(first.status);
      expect(JSON.stringify(withoutTimestamp(second.body))).toBe(
        JSON.stringify(withoutTimestamp(first.body)),
      );
    });

    it("sorts rules that reach the comparator in descending order", async () => {
      // Zod reports the issues in declaration order (email before min), so the
      // comparator is handed (too_small, invalid_string) — the `a.rule > b.rule`
      // arm — and must still emit ascending output.
      const { app } = appWithBody(z.object({ email: z.string().email().min(20) }));
      const res = await request(app).post("/test").send({ email: "abc" });

      expect(res.status).toBe(400);
      expect(res.body.details.map((d: ValidationDetail) => d.rule)).toEqual([
        "invalid_string",
        "too_small",
      ]);
      // The headline still names the first issue in request order.
      expect(res.body.error).toBe("Invalid email");
    });

    it("treats two issues with the same path and rule as interchangeable", async () => {
      const { app } = appWithBody(z.object({ email: z.string().email().regex(/^x/) }));
      const res = await request(app).post("/test").send({ email: "abc" });

      expect(res.status).toBe(400);
      expect(res.body.details.map((d: ValidationDetail) => d.path)).toEqual(["email", "email"]);
      expect(res.body.details.map((d: ValidationDetail) => d.rule)).toEqual([
        "invalid_string",
        "invalid_string",
      ]);
    });
  });

  describe("status resolution (malformed vs impossible)", () => {
    it("defaults to 400 when no status is supplied", async () => {
      const { app, handler } = appWithBody(z.object({ startTime: z.number() }));
      const res = await request(app).post("/test").send({ startTime: "tomorrow" });

      expect(res.status).toBe(400);
      expect(handler).not.toHaveBeenCalled();
    });

    it("keeps the route status when the failing field was actually sent", async () => {
      const { app, handler } = appWithBody(z.object({ startTime: z.number() }), 422);
      const res = await request(app).post("/test").send({ startTime: "tomorrow" });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(handler).not.toHaveBeenCalled();
    });

    it("never raises above an explicit 400", async () => {
      const { app } = appWithBody(z.object({ startTime: z.number() }), 400);
      const res = await request(app).post("/test").send({ startTime: "tomorrow" });

      expect(res.status).toBe(400);
    });

    it("forces 400 when every failing field was absent from the body", async () => {
      const { app } = appWithBody(z.object({ startTime: z.number(), endTime: z.number() }), 422);
      const res = await request(app).post("/test").send({});

      expect(res.status).toBe(400);
      expect(res.body.details.map((d: ValidationDetail) => d.path)).toEqual([
        "endTime",
        "startTime",
      ]);
    });

    it("forces 400 for a union field that was never sent", async () => {
      // A missing key surfaces as `invalid_union`, not `invalid_type`.
      const { app } = appWithBody(z.object({ startTime: z.union([z.number(), z.string()]) }), 422);
      const res = await request(app).post("/test").send({});

      expect(res.status).toBe(400);
      expect(res.body.details[0].path).toBe("startTime");
    });

    it("forces 400 for nested paths (membership is tested on top-level keys)", async () => {
      const { app } = appWithBody(z.object({ user: z.object({ email: z.string() }) }), 422);
      const res = await request(app)
        .post("/test")
        .send({ user: { email: 42 } });

      expect(res.status).toBe(400);
      expect(res.body.details[0].path).toBe("user.email");
    });
  });

  describe("internal failures", () => {
    it("maps a ZodError thrown by the schema into the normal envelope", async () => {
      const thrown = new ZodError([
        { code: z.ZodIssueCode.custom, path: ["legacy"], message: "boom" },
      ]);
      const { app, handler } = appWithBody(throwingSchema(thrown));
      const res = await request(app).post("/test").send({});

      expect(res.status).toBe(400);
      expect(handler).not.toHaveBeenCalled();
      expect(res.body).toMatchObject({ success: false, code: "VALIDATION_ERROR" });
      expect(res.body.details).toEqual([{ path: "legacy", rule: "custom", message: "boom" }]);
    });

    it("never leaks an unexpected thrown error to the client", async () => {
      const thrown = new Error("kaboom: secret internals");
      const { app, handler } = appWithBody(throwingSchema(thrown));
      const res = await request(app).post("/test").send({ email: "a@example.com" });

      expect(res.status).toBe(500);
      expect(handler).not.toHaveBeenCalled();
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("INTERNAL_ERROR");
      expect(JSON.stringify(res.body)).not.toContain("kaboom");
    });
  });
});
