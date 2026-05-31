import request from "supertest";
import { createApp } from "../../app.js";
import { setFeatureFlagsFromEnv } from "../../flags/service.js";
import { CheckoutSessionService } from "../../services/checkout.js";

const app = createApp({ enableContentNegotiation: false });

const JSON_CT = { "Content-Type": "application/json" };

const validBody = {
  payment: { amount: 1000, currency: "USD", paymentMethod: "credit_card" },
  customer: { customerId: "cust-123", email: "test@example.com" },
};

async function createSession(overrides = {}) {
  return request(app)
    .post("/api/v1/checkout/sessions")
    .set(JSON_CT)
    .send({ ...validBody, ...overrides });
}

async function post(path: string, body: object = {}) {
  return request(app).post(path).set(JSON_CT).send(body);
}

beforeEach(() => {
  process.env.FF_CHECKOUT = "true";
  setFeatureFlagsFromEnv(process.env);
  CheckoutSessionService.clearAllSessions();
});

afterAll(() => {
  delete process.env.FF_CHECKOUT;
  setFeatureFlagsFromEnv(process.env);
  CheckoutSessionService.clearAllSessions();
});

// ── Feature flag kill-switch ──────────────────────────────────────────────────

describe("FF_CHECKOUT kill-switch", () => {
  it("returns 503 on all routes when flag is off", async () => {
    process.env.FF_CHECKOUT = "false";
    setFeatureFlagsFromEnv(process.env);

    const res = await createSession();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, code: "FEATURE_DISABLED" });
  });
});

// ── POST /sessions — create ───────────────────────────────────────────────────

describe("POST /api/v1/checkout/sessions", () => {
  it("creates a session and returns 201 with PENDING status", async () => {
    const res = await createSession();
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.session).toMatchObject({
      status: "pending",
      payment: { amount: 1000, currency: "USD", paymentMethod: "credit_card" },
      customer: { customerId: "cust-123", email: "test@example.com" },
    });
    expect(res.body.session.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(res.body.checkoutUrl).toContain(res.body.session.id);
  });

  it("returns 400 when payment object is missing", async () => {
    const res = await request(app)
      .post("/api/v1/checkout/sessions")
      .set(JSON_CT)
      .send({ customer: validBody.customer });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 when customer object is missing", async () => {
    const res = await request(app)
      .post("/api/v1/checkout/sessions")
      .set(JSON_CT)
      .send({ payment: validBody.payment });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 for invalid amount (zero)", async () => {
    const res = await createSession({ payment: { ...validBody.payment, amount: 0 } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_AMOUNT");
  });

  it("returns 400 for invalid amount (negative)", async () => {
    const res = await createSession({ payment: { ...validBody.payment, amount: -5 } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_AMOUNT");
  });

  it("returns 400 for unsupported currency", async () => {
    const res = await createSession({ payment: { ...validBody.payment, currency: "JPY" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_CURRENCY");
  });

  it("returns 400 for unsupported payment method", async () => {
    const res = await createSession({ payment: { ...validBody.payment, paymentMethod: "paypal" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PAYMENT_METHOD");
  });

  it("returns 400 for invalid email", async () => {
    const res = await createSession({ customer: { ...validBody.customer, email: "not-an-email" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_EMAIL");
  });

  it("returns 400 for invalid customerId (special chars)", async () => {
    const res = await createSession({ customer: { ...validBody.customer, customerId: "bad id!" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_CUSTOMER_ID");
  });
});

// ── GET /sessions/:sessionId ──────────────────────────────────────────────────

describe("GET /api/v1/checkout/sessions/:sessionId", () => {
  it("retrieves an existing session", async () => {
    const { body: created } = await createSession();
    const res = await request(app).get(
      `/api/v1/checkout/sessions/${created.session.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe(created.session.id);
    expect(res.body.session.status).toBe("pending");
  });

  it("returns 404 for an unknown UUID", async () => {
    const res = await request(app).get(
      "/api/v1/checkout/sessions/00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: "SESSION_NOT_FOUND" });
  });

  it("returns 400 for a malformed (non-UUID) session id", async () => {
    const res = await request(app).get("/api/v1/checkout/sessions/not-a-uuid");
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ── Lifecycle: create → complete ─────────────────────────────────────────────

describe("Lifecycle: create → complete", () => {
  it("transitions PENDING → COMPLETED", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    const res = await post(`/api/v1/checkout/sessions/${id}/complete`, {
      paymentToken: "tok_abc",
    });

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("completed");
    expect(res.body.session.paymentToken).toBe("tok_abc");
  });

  it("returns 409 when completing an already-completed session", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    await post(`/api/v1/checkout/sessions/${id}/complete`);
    const res = await post(`/api/v1/checkout/sessions/${id}/complete`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: "INVALID_SESSION_STATE" });
  });
});

// ── Lifecycle: create → cancel ────────────────────────────────────────────────

describe("Lifecycle: create → cancel", () => {
  it("transitions PENDING → CANCELLED", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    const res = await post(`/api/v1/checkout/sessions/${id}/cancel`);

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("cancelled");
  });

  it("returns 409 when completing a cancelled session", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    await post(`/api/v1/checkout/sessions/${id}/cancel`);
    const res = await post(`/api/v1/checkout/sessions/${id}/complete`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: "INVALID_SESSION_STATE" });
  });

  it("returns 409 when cancelling an already-cancelled session", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    await post(`/api/v1/checkout/sessions/${id}/cancel`);
    const res = await post(`/api/v1/checkout/sessions/${id}/cancel`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: "INVALID_SESSION_STATE" });
  });
});

// ── Lifecycle: create → fail ──────────────────────────────────────────────────

describe("Lifecycle: create → fail", () => {
  it("transitions PENDING → FAILED", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    const res = await post(`/api/v1/checkout/sessions/${id}/fail`, {
      reason: "card declined",
    });

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("failed");
  });

  it("returns 409 when failing an already-failed session", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    await post(`/api/v1/checkout/sessions/${id}/fail`);
    const res = await post(`/api/v1/checkout/sessions/${id}/fail`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: "INVALID_SESSION_STATE" });
  });

  it("returns 409 when cancelling a failed session", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    await post(`/api/v1/checkout/sessions/${id}/fail`);
    const res = await post(`/api/v1/checkout/sessions/${id}/cancel`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: "INVALID_SESSION_STATE" });
  });
});

// ── POST /sessions/:id/pay ────────────────────────────────────────────────────

describe("POST /api/v1/checkout/sessions/:sessionId/pay", () => {
  it("returns 200 with COMPLETED or FAILED status", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    const res = await post(`/api/v1/checkout/sessions/${id}/pay`);

    expect(res.status).toBe(200);
    expect(["completed", "failed"]).toContain(res.body.session.status);
  });

  it("returns 409 when paying a completed session", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    await post(`/api/v1/checkout/sessions/${id}/complete`);
    const res = await post(`/api/v1/checkout/sessions/${id}/pay`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: "INVALID_SESSION_STATE" });
  });

  it("returns 404 for unknown session id", async () => {
    const res = await post(
      "/api/v1/checkout/sessions/00000000-0000-0000-0000-000000000000/pay",
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: "SESSION_NOT_FOUND" });
  });

  it("returns 400 for malformed session id", async () => {
    const res = await post("/api/v1/checkout/sessions/bad-id/pay");
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ── Expired session (410) ─────────────────────────────────────────────────────

describe("Expired session", () => {
  it("returns 410 when accessing an expired session", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    // Manually expire the session by backdating expiresAt
    const session = CheckoutSessionService.getSession(id);
    (session as any).expiresAt = Math.floor(Date.now() / 1000) - 1;

    const res = await request(app).get(`/api/v1/checkout/sessions/${id}`);
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ success: false, code: "SESSION_EXPIRED" });
  });

  it("returns 410 when completing an expired session", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    const session = CheckoutSessionService.getSession(id);
    (session as any).expiresAt = Math.floor(Date.now() / 1000) - 1;

    const res = await post(`/api/v1/checkout/sessions/${id}/complete`);
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ success: false, code: "SESSION_EXPIRED" });
  });
});

// ── 404 / 400 on state-transition routes ─────────────────────────────────────

describe("404 and 400 on state-transition routes", () => {
  const unknownId = "00000000-0000-0000-0000-000000000000";
  const badId = "not-a-uuid";

  it.each([
    ["complete", unknownId, 404],
    ["cancel", unknownId, 404],
    ["fail", unknownId, 404],
    ["complete", badId, 400],
    ["cancel", badId, 400],
    ["fail", badId, 400],
  ])("POST /%s with id=%s returns %i", async (action, id, expectedStatus) => {
    const res = await post(`/api/v1/checkout/sessions/${id}/${action}`);
    expect(res.status).toBe(expectedStatus);
    expect(res.body.success).toBe(false);
  });
});
