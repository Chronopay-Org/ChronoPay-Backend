import { afterAll, afterEach, beforeEach, expect, it, jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { validateCreateCheckoutSession } from "../checkout-validation.js";
import { isAllowedCheckoutRedirect } from "../../config/checkoutRedirects.js";
import { CheckoutSessionService, setCheckoutRepository } from "../../services/checkout.js";
import { PgCheckoutSessionRepository } from "../../modules/checkout/pg-checkout-session-repository.js";
import { defaultAuditLogger } from "../../services/auditLogger.js";

const originalEnv = { ...process.env };
afterAll(() => {
  process.env = originalEnv;
});
afterEach(() => {
  jest.restoreAllMocks();
});
beforeEach(() => {
  process.env.NODE_ENV = "production";
  process.env.CHECKOUT_REDIRECT_ALLOWED_HOSTS = "app.example";
  delete process.env.APP_URL;
});

const body = () => ({
  payment: { amount: 1000, currency: "USD", paymentMethod: "credit_card" },
  customer: { customerId: "customer-1", email: "user@example.com" },
});

function app() {
  const instance = express();
  instance.use(express.json());
  instance.post("/sessions", validateCreateCheckoutSession(), (_req, res) =>
    res.status(201).json({ accepted: true }),
  );
  return instance;
}

it("rejects a javascript success redirect before creating a checkout session", async () => {
  const res = await request(app())
    .post("/sessions")
    .send({ ...body(), successUrl: "javascript:alert(1)" });
  expect(res.status).toBe(400);
  expect(res.body.details.field).toBe("successUrl");
});

it.each(["successUrl", "cancelUrl"] as const)(
  "validates every invalid %s value with the checkout error envelope",
  async (field) => {
    const invalid: unknown[] = [
      "javascript:alert(1)",
      "data:text/html,hello",
      "https://evil.example/",
      "x".repeat(3000),
      "https://app.example.evil.example/",
      "https://app.example@evil.example/",
      "//app.example/",
      "https:app.example/path",
      "https://user:secret@app.example/",
      "https://app.example:8443/",
      "https://app.example\\@evil.example/",
      " https://app.example/",
      "https://app.example/\n",
      "https://[",
      "",
      null,
      123,
      [],
      {},
    ];
    for (const value of invalid) {
      const res = await request(app())
        .post("/sessions")
        .send({ ...body(), [field]: value });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        code: "INVALID_REDIRECT_URL",
        details: { field },
      });
      expect(res.body.details).toEqual({ field });
    }
  },
);

it("allows omitted optional fields and allowed HTTPS URLs without changing them", async () => {
  expect((await request(app()).post("/sessions").send(body())).status).toBe(201);
  const res = await request(app())
    .post("/sessions")
    .send({
      ...body(),
      successUrl: "https://APP.example/ok?session=1#done",
      cancelUrl: "https://app.example/cancel",
    });
  expect(res.status).toBe(201);
});

it("enforces the 2048-character boundary for both fields", async () => {
  const prefix = "https://app.example/";
  for (const field of ["successUrl", "cancelUrl"]) {
    for (const [length, status] of [
      [2048, 201],
      [2049, 400],
    ]) {
      const res = await request(app())
        .post("/sessions")
        .send({ ...body(), [field]: prefix + "a".repeat(length - prefix.length) });
      expect(res.status).toBe(status);
    }
  }
});

it.each(["test", "development", "production"])(
  "enforces HTTP policy in %s",
  async (environment) => {
    process.env.NODE_ENV = environment;
    const res = await request(app())
      .post("/sessions")
      .send({ ...body(), cancelUrl: "http://app.example/cancel" });
    expect(res.status).toBe(environment === "production" ? 400 : 201);
  },
);

it("uses APP_URL only when the explicit allowlist is absent", () => {
  const env = { NODE_ENV: "test", APP_URL: "http://localhost:3000/application" };
  expect(isAllowedCheckoutRedirect("http://localhost:3000/ok", env)).toBe(true);
  expect(isAllowedCheckoutRedirect("http://localhost:3001/ok", env)).toBe(false);
  expect(
    isAllowedCheckoutRedirect("https://app.example/ok", {
      ...env,
      CHECKOUT_REDIRECT_ALLOWED_HOSTS: " app.example, other.example:8443 ",
    }),
  ).toBe(true);
  expect(
    isAllowedCheckoutRedirect("https://other.example:8443/ok", {
      ...env,
      CHECKOUT_REDIRECT_ALLOWED_HOSTS: "other.example:8443",
    }),
  ).toBe(true);
  expect(
    isAllowedCheckoutRedirect("http://localhost:3000/ok", {
      ...env,
      CHECKOUT_REDIRECT_ALLOWED_HOSTS: "app.example",
    }),
  ).toBe(false);
});

it("denies supplied redirects without valid host configuration", () => {
  const env = { NODE_ENV: "production" };
  expect(isAllowedCheckoutRedirect("https://app.example/ok", env)).toBe(false);
  for (const APP_URL of ["bad", "javascript:alert(1)", "https://user:secret@app.example"]) {
    expect(isAllowedCheckoutRedirect("https://app.example/ok", { ...env, APP_URL })).toBe(false);
  }
  for (const list of [
    "",
    "app.example,",
    "*.example",
    "https://app.example",
    "user@app.example",
    "app.example/path",
    "app.example?x=1",
    "app.example#hash",
    "app.example%2f.evil",
  ]) {
    expect(
      isAllowedCheckoutRedirect("https://app.example/ok", {
        ...env,
        APP_URL: "https://app.example",
        CHECKOUT_REDIRECT_ALLOWED_HOSTS: list,
      }),
    ).toBe(false);
  }
});

it("passes allowed URLs unchanged through the real service and repository mapping", async () => {
  // Only the external DB/audit I/O boundary is substituted; the validator,
  // service, INSERT parameter construction and row mapping are real.
  jest.spyOn(defaultAuditLogger, "log").mockResolvedValue(undefined);
  let saved: unknown[] = [];
  const repo = new PgCheckoutSessionRepository(async (_sql, params = []) => {
    saved = params;
    return {
      command: "INSERT",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [
        {
          id: params[0],
          payment: JSON.parse(params[1] as string),
          customer: JSON.parse(params[2] as string),
          status: params[3],
          success_url: params[5],
          cancel_url: params[6],
          created_at: new Date(Number(params[8]) * 1000),
          updated_at: new Date(Number(params[9]) * 1000),
          expires_at: new Date(Number(params[10]) * 1000),
        },
      ],
    };
  });
  setCheckoutRepository(repo);
  const instance = express();
  instance.use(express.json());
  instance.post("/sessions", validateCreateCheckoutSession(), async (req, res, next) => {
    try {
      res.status(201).json(await CheckoutSessionService.createSession(req.body));
    } catch (error) {
      next(error);
    }
  });
  const urls = {
    successUrl: "https://app.example/ok?session=1",
    cancelUrl: "https://app.example/cancel",
  };
  const res = await request(instance)
    .post("/sessions")
    .send({ ...body(), ...urls });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject(urls);
  expect(saved.slice(5, 7)).toEqual([urls.successUrl, urls.cancelUrl]);
  saved = [];
  const rejected = await request(instance)
    .post("/sessions")
    .send({ ...body(), successUrl: "https://evil.example" });
  expect(rejected.status).toBe(400);
  expect(saved).toEqual([]);
});
