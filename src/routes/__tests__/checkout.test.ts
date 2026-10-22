/**
 * Checkout Session Route – functional / lifecycle tests.
 *
 * Auth is threaded through every request now that all endpoints are protected.
 * Auth-specific scenarios (anonymous 401, other-user 403, admin access) live in
 * checkout.auth.test.ts; this file focuses on correct lifecycle transitions.
 */

import request from "supertest";
import { createApp } from "../../app.js";
import { setFeatureFlagsFromEnv } from "../../flags/service.js";
import { CheckoutSession, CheckoutSessionStatus } from "../../types/checkout.js";
import {
  CheckoutSessionService,
  setCheckoutPaymentProvider,
  setCheckoutRepository,
} from "../../services/checkout.js";
import { PgCheckoutSessionRepository } from "../../modules/checkout/pg-checkout-session-repository.js";
import { signJwt } from "../../utils/jwt.js";
import { createHmac } from "node:crypto";
import { configService } from "../../config/config.service.js";

const app = createApp({ enableContentNegotiation: false });

const JSON_CT = { "Content-Type": "application/json" };
const JWT_SECRET = "checkout-lifecycle-test-secret-32b!";
const HMAC_SECRET = "checkout-lifecycle-hmac-secret-abc123";
const OWNER_ID = "cust-123";

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

async function makeToken(sub: string, role = "user"): Promise<string> {
  return signJwt(
    { sub, role, email: `${sub}@example.com`, iat: Math.floor(Date.now() / 1000) },
    JWT_SECRET,
    { expiresInSec: 3600 },
  );
}

function hmacSign(body: object): string {
  return createHmac("sha256", HMAC_SECRET).update(JSON.stringify(body)).digest("hex");
}

let ownerToken: string;
let adminToken: string;

// ---------------------------------------------------------------------------
// In-memory repository
// ---------------------------------------------------------------------------

let sessionStore: Map<string, CheckoutSession>;

function makeInMemoryRepo(): PgCheckoutSessionRepository {
  const store = new Map<string, CheckoutSession>();
  sessionStore = store;
  return {
    create: async (session: CheckoutSession): Promise<CheckoutSession> => {
      store.set(session.id, { ...session });
      return { ...session };
    },
    findById: async (id: string): Promise<CheckoutSession | null> => {
      const found = store.get(id);
      return found ? { ...found } : null;
    },
    updateSession: async (
      id: string,
      fields: {
        status: CheckoutSessionStatus;
        updatedAt: number;
        paymentToken?: string;
        metadata?: Record<string, string | number | boolean>;
      },
    ): Promise<CheckoutSession> => {
      const current = store.get(id);
      if (!current) {
        throw new Error(`session ${id} not found`);
      }
      const updated: CheckoutSession = {
        ...current,
        status: fields.status,
        updatedAt: fields.updatedAt,
        ...(fields.paymentToken !== undefined ? { paymentToken: fields.paymentToken } : {}),
        ...(fields.metadata !== undefined ? { metadata: fields.metadata } : {}),
      };
      store.set(id, updated);
      return { ...updated };
    },
  } as unknown as PgCheckoutSessionRepository;
}

// ---------------------------------------------------------------------------
// Request helpers (all include auth by default)
// ---------------------------------------------------------------------------

const validBody = {
  payment: { amount: 1000, currency: "USD", paymentMethod: "credit_card" },
  customer: { customerId: OWNER_ID, email: "test@example.com" },
};

/** Create a session (anonymous — create endpoint is open). */
async function createSession(overrides = {}) {
  return request(app)
    .post("/api/v1/checkout/sessions")
    .set(JSON_CT)
    .send({ ...validBody, ...overrides });
}

/** POST to a session sub-route with the owner JWT (used for cancel/pay). */
async function postOwner(path: string, body: object = {}) {
  return request(app)
    .post(path)
    .set(JSON_CT)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send(body);
}

/** POST to /complete or /fail with a valid HMAC signature. */
async function postHmac(path: string, body: object = {}) {
  return request(app)
    .post(path)
    .set(JSON_CT)
    .set("x-webhook-signature", hmacSign(body))
    .send(body);
}

/** POST to /complete or /fail as admin (no HMAC). */
async function postAdmin(path: string, body: object = {}) {
  return request(app)
    .post(path)
    .set(JSON_CT)
    .set("Authorization", `Bearer ${adminToken}`)
    .send(body);
}

/** Raw unauthenticated POST (for bad-id / 404 checks that hit validation before auth). */
async function postRaw(path: string, body: object = {}) {
  return request(app).post(path).set(JSON_CT).send(body);
}

// ---------------------------------------------------------------------------
// Lifecycle setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  process.env.FF_CHECKOUT = "true";
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.CHECKOUT_WEBHOOK_SECRET = HMAC_SECRET;
  setFeatureFlagsFromEnv(process.env);
  configService.refresh();
  CheckoutSessionService.clearAllSessions();
  setCheckoutRepository(makeInMemoryRepo());
  ownerToken = await makeToken(OWNER_ID);
  adminToken = await makeToken("admin-user", "admin");
});

afterAll(() => {
  delete process.env.FF_CHECKOUT;
  delete process.env.JWT_SECRET;
  delete process.env.CHECKOUT_WEBHOOK_SECRET;
  configService.refresh();
  setFeatureFlagsFromEnv(process.env);
  CheckoutSessionService.clearAllSessions();
});

// ---------------------------------------------------------------------------
// Feature flag kill-switch
// ---------------------------------------------------------------------------

describe("FF_CHECKOUT kill-switch", () => {
  it("returns 503 on all routes when flag is off", async () => {
    process.env.FF_CHECKOUT = "false";
    setFeatureFlagsFromEnv(process.env);

    const res = await createSession();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, code: "FEATURE_DISABLED" });
  });
});

// ---------------------------------------------------------------------------
// POST /sessions — create
// ---------------------------------------------------------------------------

describe("POST /api/v1/checkout/sessions", () => {
  it("creates a session and returns 201 with PENDING status", async () => {
    const res = await createSession();
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.session).toMatchObject({
      status: "pending",
      payment: { amount: 1000, currency: "USD", paymentMethod: "credit_card" },
      customer: { customerId: OWNER_ID, email: "test@example.com" },
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

// ---------------------------------------------------------------------------
// GET /sessions/:sessionId
// ---------------------------------------------------------------------------

describe("GET /api/v1/checkout/sessions/:sessionId", () => {
  it("retrieves an existing session (owner)", async () => {
    const { body: created } = await createSession();
    const res = await request(app)
      .get(`/api/v1/checkout/sessions/${created.session.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe(created.session.id);
    expect(res.body.session.status).toBe("pending");
  });

  it("returns 404 for an unknown UUID (with auth)", async () => {
    const res = await request(app)
      .get("/api/v1/checkout/sessions/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: "SESSION_NOT_FOUND" });
  });

  it("returns 400 for a malformed (non-UUID) session id", async () => {
    const res = await request(app).get("/api/v1/checkout/sessions/not-a-uuid");
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: create → complete (HMAC)
// ---------------------------------------------------------------------------

describe("Lifecycle: create → complete", () => {
  it("transitions PENDING → COMPLETED (HMAC)", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;
    const body = { paymentToken: "tok_abc" };

    const res = await postHmac(`/api/v1/checkout/sessions/${id}/complete`, body);

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("completed");
    expect(res.body.session.paymentToken).toBe("tok_abc");
  });

  it("returns 409 when completing an already-completed session (admin)", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    await postAdmin(`/api/v1/checkout/sessions/${id}/complete`);
    const res = await postAdmin(`/api/v1/checkout/sessions/${id}/complete`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: "INVALID_SESSION_STATE" });
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: create → cancel
// ---------------------------------------------------------------------------

describe("Lifecycle: create → cancel", () => {
  it("transitions PENDING → CANCELLED (owner)", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    const res = await postOwner(`/api/v1/checkout/sessions/${id}/cancel`);

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("cancelled");
  });

  it("returns 409 when completing a cancelled session (admin)", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    await postOwner(`/api/v1/checkout/sessions/${id}/cancel`);
    const res = await postAdmin(`/api/v1/checkout/sessions/${id}/complete`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: "INVALID_SESSION_STATE" });
  });

  it("returns 409 when cancelling an already-cancelled session (owner)", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    await postOwner(`/api/v1/checkout/sessions/${id}/cancel`);
    const res = await postOwner(`/api/v1/checkout/sessions/${id}/cancel`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: "INVALID_SESSION_STATE" });
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: create → fail
// ---------------------------------------------------------------------------

describe("Lifecycle: create → fail", () => {
  it("transitions PENDING → FAILED (HMAC)", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;
    const body = { reason: "card declined" };

    const res = await postHmac(`/api/v1/checkout/sessions/${id}/fail`, body);

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("failed");
  });

  it("returns 409 when failing an already-failed session (admin)", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    await postAdmin(`/api/v1/checkout/sessions/${id}/fail`);
    const res = await postAdmin(`/api/v1/checkout/sessions/${id}/fail`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: "INVALID_SESSION_STATE" });
  });

  it("returns 409 when cancelling a failed session (owner)", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    await postAdmin(`/api/v1/checkout/sessions/${id}/fail`);
    const res = await postOwner(`/api/v1/checkout/sessions/${id}/cancel`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: "INVALID_SESSION_STATE" });
  });
});

// ---------------------------------------------------------------------------
// POST /sessions/:id/pay
// ---------------------------------------------------------------------------

describe("POST /api/v1/checkout/sessions/:sessionId/pay", () => {
  it("returns 200 with COMPLETED or FAILED status (owner)", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    const res = await postOwner(`/api/v1/checkout/sessions/${id}/pay`);

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe(CheckoutSessionStatus.COMPLETED);
    expect(res.body.session.paymentToken).toBe("route_test_ref");
  });

  it("returns 409 when paying a completed session (owner then admin complete)", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    await postAdmin(`/api/v1/checkout/sessions/${id}/complete`);
    const res = await postOwner(`/api/v1/checkout/sessions/${id}/pay`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: "INVALID_SESSION_STATE" });
  });

  it("returns 404 for unknown session id (auth provided)", async () => {
    const res = await postOwner(
      "/api/v1/checkout/sessions/00000000-0000-0000-0000-000000000000/pay",
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: "SESSION_NOT_FOUND" });
  });

  it("returns 400 for malformed session id (no auth needed — validation runs first)", async () => {
    const res = await postRaw("/api/v1/checkout/sessions/bad-id/pay");
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Expired session (410)
// ---------------------------------------------------------------------------

describe("Expired session", () => {
  it("returns 410 when accessing an expired session (owner)", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    // Manually expire the session by backdating expiresAt in the store.
    const stored = sessionStore.get(id);
    stored!.expiresAt = Math.floor(Date.now() / 1000) - 1;

    const res = await request(app)
      .get(`/api/v1/checkout/sessions/${id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ success: false, code: "SESSION_EXPIRED" });
  });

  it("returns 410 when completing an expired session (HMAC)", async () => {
    const { body: created } = await createSession();
    const id = created.session.id;

    const stored = sessionStore.get(id);
    stored!.expiresAt = Math.floor(Date.now() / 1000) - 1;

    const res = await postHmac(`/api/v1/checkout/sessions/${id}/complete`);
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ success: false, code: "SESSION_EXPIRED" });
  });
});

// ---------------------------------------------------------------------------
// 404 / 400 on state-transition routes
// ---------------------------------------------------------------------------

describe("404 and 400 on state-transition routes", () => {
  const unknownId = "00000000-0000-0000-0000-000000000000";
  const badId = "not-a-uuid";

  // For /complete and /fail, use admin auth (HMAC-less path) or HMAC.
  // For bad IDs, validation fires before auth so no token needed.
  // For unknown UUIDs that reach DB, we need auth that would pass.

  it("POST /complete with unknown id returns 404 (HMAC)", async () => {
    const body = {};
    const res = await request(app)
      .post(`/api/v1/checkout/sessions/${unknownId}/complete`)
      .set(JSON_CT)
      .set("x-webhook-signature", hmacSign(body))
      .send(body);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("POST /cancel with unknown id returns 404 (owner token)", async () => {
    const res = await postOwner(`/api/v1/checkout/sessions/${unknownId}/cancel`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("POST /fail with unknown id returns 404 (HMAC)", async () => {
    const body = {};
    const res = await request(app)
      .post(`/api/v1/checkout/sessions/${unknownId}/fail`)
      .set(JSON_CT)
      .set("x-webhook-signature", hmacSign(body))
      .send(body);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it.each([
    ["complete", badId, 400],
    ["cancel", badId, 400],
    ["fail", badId, 400],
  ])("POST /%s with id=%s returns %i (no auth needed — validation first)", async (action, id, expectedStatus) => {
    const res = await postRaw(`/api/v1/checkout/sessions/${id}/${action}`);
    expect(res.status).toBe(expectedStatus);
    expect(res.body.success).toBe(false);
  });
});
