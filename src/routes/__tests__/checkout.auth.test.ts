/**
 * Checkout Session Route – Authentication & Ownership Tests
 *
 * Covers acceptance criteria for #1303:
 *  - Unauthenticated requests to GET, pay, fail, cancel return 401.
 *  - Another customer's token returns 403 on GET, pay, cancel.
 *  - /complete and /fail succeed only for HMAC-signed callers or admins.
 *  - A regular customer cannot call /complete or /fail with their JWT.
 *  - POST /sessions with a JWT whose sub ≠ customer.customerId returns 403.
 *  - Regression: anonymous /complete (no auth) returns 401 (was previously
 *    unguarded on the main branch).
 */

import { createHmac } from "node:crypto";
import request from "supertest";
import { createApp } from "../../app.js";
import { setFeatureFlagsFromEnv } from "../../flags/service.js";
import { CheckoutSession, CheckoutSessionStatus } from "../../types/checkout.js";
import { CheckoutSessionService, setCheckoutRepository } from "../../services/checkout.js";
import { PgCheckoutSessionRepository } from "../../modules/checkout/pg-checkout-session-repository.js";
import { signJwt } from "../../utils/jwt.js";
import { configService } from "../../config/config.service.js";

// ---------------------------------------------------------------------------
// App & constants
// ---------------------------------------------------------------------------

const app = createApp({ enableContentNegotiation: false });

const JSON_CT = { "Content-Type": "application/json" };
const JWT_SECRET = "checkout-auth-test-secret-32bytes!!";
const HMAC_SECRET = "checkout-webhook-hmac-secret-abc123";

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
      if (!current) throw new Error(`session ${id} not found`);
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
// JWT helpers
// ---------------------------------------------------------------------------

async function makeToken(sub: string, role = "user"): Promise<string> {
  return signJwt(
    { sub, role, email: `${sub}@example.com`, iat: Math.floor(Date.now() / 1000) },
    JWT_SECRET,
    { expiresInSec: 3600 },
  );
}

// ---------------------------------------------------------------------------
// HMAC helper (signs the raw JSON request body)
// ---------------------------------------------------------------------------

function hmacSign(body: object, secret = HMAC_SECRET): string {
  return createHmac("sha256", secret).update(JSON.stringify(body)).digest("hex");
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

const OWNER_ID = "cust-auth-owner";
const OTHER_ID = "cust-auth-other";

const validBody = {
  payment: { amount: 1000, currency: "USD", paymentMethod: "credit_card" },
  customer: { customerId: OWNER_ID, email: "owner@example.com" },
};

async function createSession(authToken?: string) {
  const req = request(app).post("/api/v1/checkout/sessions").set(JSON_CT).send(validBody);
  if (authToken) req.set("Authorization", `Bearer ${authToken}`);
  return req;
}

async function getSession(sessionId: string, authToken?: string) {
  const req = request(app).get(`/api/v1/checkout/sessions/${sessionId}`);
  if (authToken) req.set("Authorization", `Bearer ${authToken}`);
  return req;
}

async function completeSession(
  sessionId: string,
  opts: { authToken?: string; hmacBody?: object; hmacSecret?: string } = {},
) {
  const body = opts.hmacBody ?? {};
  const req = request(app)
    .post(`/api/v1/checkout/sessions/${sessionId}/complete`)
    .set(JSON_CT)
    .send(body);
  if (opts.authToken) req.set("Authorization", `Bearer ${opts.authToken}`);
  if (opts.hmacBody !== undefined || opts.hmacSecret !== undefined) {
    req.set("x-webhook-signature", hmacSign(body, opts.hmacSecret ?? HMAC_SECRET));
  }
  return req;
}

async function paySession(sessionId: string, authToken?: string) {
  const req = request(app)
    .post(`/api/v1/checkout/sessions/${sessionId}/pay`)
    .set(JSON_CT)
    .send({});
  if (authToken) req.set("Authorization", `Bearer ${authToken}`);
  return req;
}

async function failSession(
  sessionId: string,
  opts: { authToken?: string; hmacBody?: object; hmacSecret?: string } = {},
) {
  const body = opts.hmacBody ?? {};
  const req = request(app)
    .post(`/api/v1/checkout/sessions/${sessionId}/fail`)
    .set(JSON_CT)
    .send(body);
  if (opts.authToken) req.set("Authorization", `Bearer ${opts.authToken}`);
  if (opts.hmacBody !== undefined || opts.hmacSecret !== undefined) {
    req.set("x-webhook-signature", hmacSign(body, opts.hmacSecret ?? HMAC_SECRET));
  }
  return req;
}

async function cancelSession(sessionId: string, authToken?: string) {
  const req = request(app)
    .post(`/api/v1/checkout/sessions/${sessionId}/cancel`)
    .set(JSON_CT)
    .send({});
  if (authToken) req.set("Authorization", `Bearer ${authToken}`);
  return req;
}

// ---------------------------------------------------------------------------
// Lifecycle setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  process.env.FF_CHECKOUT = "true";
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.CHECKOUT_WEBHOOK_SECRET = HMAC_SECRET;
  setFeatureFlagsFromEnv(process.env);
  configService.refresh();
  CheckoutSessionService.clearAllSessions();
  setCheckoutRepository(makeInMemoryRepo());
});

afterEach(() => {
  delete process.env.CHECKOUT_WEBHOOK_SECRET;
  delete process.env.SETTLEMENTS_WEBHOOK_SECRET;
});

afterAll(() => {
  delete process.env.FF_CHECKOUT;
  delete process.env.JWT_SECRET;
  configService.refresh();
  setFeatureFlagsFromEnv(process.env);
  CheckoutSessionService.clearAllSessions();
});

// ---------------------------------------------------------------------------
// Helper: create a session owned by OWNER_ID and return its id
// ---------------------------------------------------------------------------

async function createOwnedSession(): Promise<string> {
  const ownerToken = await makeToken(OWNER_ID);
  const res = await createSession(ownerToken);
  expect(res.status).toBe(201);
  return res.body.session.id;
}

// ===========================================================================
// Regression: anonymous /complete was previously unguarded
// ===========================================================================

describe("Regression #1303: anonymous /complete must return 401", () => {
  it("returns 401 when no auth provided to /complete (was unguarded on main)", async () => {
    const sessionId = await createOwnedSession();
    const res = await request(app)
      .post(`/api/v1/checkout/sessions/${sessionId}/complete`)
      .set(JSON_CT)
      .send({});
    // The old code would have allowed this through; the fix must block it.
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

// ===========================================================================
// POST /sessions — create with JWT auth
// ===========================================================================

describe("POST /api/v1/checkout/sessions — JWT on create", () => {
  it("creates session anonymously (no token)", async () => {
    const res = await createSession();
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it("creates session when token sub matches customerId", async () => {
    const token = await makeToken(OWNER_ID);
    const res = await createSession(token);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it("returns 403 when token sub does not match customerId", async () => {
    // Token is for OTHER_ID but the body claims OWNER_ID
    const token = await makeToken(OTHER_ID);
    const res = await createSession(token);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("returns 401 when a malformed/invalid token is provided", async () => {
    const res = await createSession("this.is.not.a.valid.jwt");
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

// ===========================================================================
// GET /sessions/:sessionId
// ===========================================================================

describe("GET /api/v1/checkout/sessions/:sessionId", () => {
  it("returns 401 when no token provided (anonymous)", async () => {
    const sessionId = await createOwnedSession();
    const res = await getSession(sessionId);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("returns 200 for the session owner", async () => {
    const sessionId = await createOwnedSession();
    const ownerToken = await makeToken(OWNER_ID);
    const res = await getSession(sessionId, ownerToken);
    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe(sessionId);
  });

  it("returns 403 for a different authenticated user", async () => {
    const sessionId = await createOwnedSession();
    const otherToken = await makeToken(OTHER_ID);
    const res = await getSession(sessionId, otherToken);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("returns 200 for an admin user", async () => {
    const sessionId = await createOwnedSession();
    const adminToken = await makeToken("admin-user", "admin");
    const res = await getSession(sessionId, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe(sessionId);
  });

  it("returns 401 for an invalid token", async () => {
    const sessionId = await createOwnedSession();
    const res = await getSession(sessionId, "bad.token.here");
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

// ===========================================================================
// POST /sessions/:sessionId/complete
// ===========================================================================

describe("POST /api/v1/checkout/sessions/:sessionId/complete", () => {
  it("returns 401 when no auth provided (anonymous)", async () => {
    const sessionId = await createOwnedSession();
    const res = await request(app)
      .post(`/api/v1/checkout/sessions/${sessionId}/complete`)
      .set(JSON_CT)
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("returns 403 when owner JWT is provided (customers cannot call /complete)", async () => {
    const sessionId = await createOwnedSession();
    const ownerToken = await makeToken(OWNER_ID);
    const res = await completeSession(sessionId, { authToken: ownerToken });
    // No HMAC header, falls to JWT path, role=user → 403
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("returns 403 for another user's JWT", async () => {
    const sessionId = await createOwnedSession();
    const otherToken = await makeToken(OTHER_ID);
    const res = await completeSession(sessionId, { authToken: otherToken });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("returns 200 for an admin JWT", async () => {
    const sessionId = await createOwnedSession();
    const adminToken = await makeToken("admin-user", "admin");
    const res = await completeSession(sessionId, { authToken: adminToken });
    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("completed");
  });

  it("returns 200 for a valid HMAC-signed provider callback", async () => {
    const sessionId = await createOwnedSession();
    const res = await completeSession(sessionId, {
      hmacBody: { paymentToken: "tok_provider_123" },
    });
    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("completed");
  });

  it("returns 403 for an HMAC-signed callback with wrong secret", async () => {
    const sessionId = await createOwnedSession();
    const res = await completeSession(sessionId, {
      hmacBody: {},
      hmacSecret: "wrong-secret-not-matching",
    });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });
});

// ===========================================================================
// POST /sessions/:sessionId/pay
// ===========================================================================

describe("POST /api/v1/checkout/sessions/:sessionId/pay", () => {
  it("returns 401 when no token provided (anonymous)", async () => {
    const sessionId = await createOwnedSession();
    const res = await paySession(sessionId);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("returns 200 for the session owner", async () => {
    const sessionId = await createOwnedSession();
    const ownerToken = await makeToken(OWNER_ID);
    const res = await paySession(sessionId, ownerToken);
    expect(res.status).toBe(200);
    expect(["completed", "failed"]).toContain(res.body.session.status);
  });

  it("returns 403 for a different authenticated user", async () => {
    const sessionId = await createOwnedSession();
    const otherToken = await makeToken(OTHER_ID);
    const res = await paySession(sessionId, otherToken);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("returns 200 for an admin user", async () => {
    const sessionId = await createOwnedSession();
    const adminToken = await makeToken("admin-user", "admin");
    const res = await paySession(sessionId, adminToken);
    expect(res.status).toBe(200);
    expect(["completed", "failed"]).toContain(res.body.session.status);
  });

  it("returns 401 for an invalid token", async () => {
    const sessionId = await createOwnedSession();
    const res = await paySession(sessionId, "not.a.real.token");
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

// ===========================================================================
// POST /sessions/:sessionId/fail
// ===========================================================================

describe("POST /api/v1/checkout/sessions/:sessionId/fail", () => {
  it("returns 401 when no auth provided (anonymous)", async () => {
    const sessionId = await createOwnedSession();
    const res = await request(app)
      .post(`/api/v1/checkout/sessions/${sessionId}/fail`)
      .set(JSON_CT)
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("returns 403 when owner JWT is provided (customers cannot call /fail)", async () => {
    const sessionId = await createOwnedSession();
    const ownerToken = await makeToken(OWNER_ID);
    const res = await failSession(sessionId, { authToken: ownerToken });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("returns 403 for another user's JWT", async () => {
    const sessionId = await createOwnedSession();
    const otherToken = await makeToken(OTHER_ID);
    const res = await failSession(sessionId, { authToken: otherToken });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("returns 200 for an admin JWT", async () => {
    const sessionId = await createOwnedSession();
    const adminToken = await makeToken("admin-user", "admin");
    const res = await failSession(sessionId, { authToken: adminToken });
    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("failed");
  });

  it("returns 200 for a valid HMAC-signed provider callback", async () => {
    const sessionId = await createOwnedSession();
    const res = await failSession(sessionId, {
      hmacBody: { reason: "card_declined" },
    });
    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("failed");
  });

  it("returns 403 for an HMAC-signed callback with wrong secret", async () => {
    const sessionId = await createOwnedSession();
    const res = await failSession(sessionId, {
      hmacBody: {},
      hmacSecret: "wrong-secret-not-matching",
    });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });
});

// ===========================================================================
// POST /sessions/:sessionId/cancel
// ===========================================================================

describe("POST /api/v1/checkout/sessions/:sessionId/cancel", () => {
  it("returns 401 when no token provided (anonymous)", async () => {
    const sessionId = await createOwnedSession();
    const res = await cancelSession(sessionId);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("returns 200 for the session owner", async () => {
    const sessionId = await createOwnedSession();
    const ownerToken = await makeToken(OWNER_ID);
    const res = await cancelSession(sessionId, ownerToken);
    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("cancelled");
  });

  it("returns 403 for a different authenticated user", async () => {
    const sessionId = await createOwnedSession();
    const otherToken = await makeToken(OTHER_ID);
    const res = await cancelSession(sessionId, otherToken);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("returns 200 for an admin user", async () => {
    const sessionId = await createOwnedSession();
    const adminToken = await makeToken("admin-user", "admin");
    const res = await cancelSession(sessionId, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("cancelled");
  });

  it("returns 401 for an invalid token", async () => {
    const sessionId = await createOwnedSession();
    const res = await cancelSession(sessionId, "garbage.token");
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

// ===========================================================================
// HMAC fallback: CHECKOUT_WEBHOOK_SECRET → SETTLEMENTS_WEBHOOK_SECRET
// ===========================================================================

describe("HMAC secret fallback: SETTLEMENTS_WEBHOOK_SECRET", () => {
  beforeEach(() => {
    delete process.env.CHECKOUT_WEBHOOK_SECRET;
    process.env.SETTLEMENTS_WEBHOOK_SECRET = HMAC_SECRET;
  });

  afterEach(() => {
    delete process.env.SETTLEMENTS_WEBHOOK_SECRET;
  });

  it("accepts a valid HMAC signed with SETTLEMENTS_WEBHOOK_SECRET", async () => {
    const sessionId = await createOwnedSession();
    const res = await completeSession(sessionId, { hmacBody: {} });
    expect(res.status).toBe(200);
  });
});
