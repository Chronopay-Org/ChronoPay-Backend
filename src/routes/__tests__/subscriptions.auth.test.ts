/**
 * Authentication & authorization matrix for /api/v1/subscriptions (issue #1311).
 *
 * Every route requires a verified JWT; ownership rules:
 *  - product create/deactivate: the professional acting for themselves, or admin
 *  - subscribe: subscriberId always comes from the token
 *  - get/pause/resume/cancel: subscriber, the product's professional, or admin
 *  - list: scoped to the caller unless admin
 *
 * Matrix per route: anonymous (401), owner (allowed), other (403), admin (allowed).
 */

import request from "supertest";
import { SignJWT } from "jose";
import { createApp } from "../../app.js";
import { configService } from "../../config/config.service.js";
import { flushMicrotasks } from "../../test-helpers/fakeMfaRepository.js";

const TEST_SECRET = "subscriptions-auth-test-secret-32ch!";

async function makeToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(TEST_SECRET));
}

function productBody(professional: string): Record<string, unknown> {
  return {
    name: `Product for ${professional}`,
    professional,
    slotDurationMs: 3_600_000,
    recurrenceRule: "FREQ=DAILY",
  };
}

describe("subscriptions auth and ownership (issue #1311)", () => {
  let app: ReturnType<typeof createApp>;
  let aliceToken: string; // professional alice
  let bobToken: string; // professional bob
  let user1Token: string; // customer user-1
  let user2Token: string; // customer user-2
  let user3Token: string; // uninvolved customer
  let adminToken: string; // admin root
  let savedSecret: string | undefined;
  let savedIssuer: string | undefined;
  let savedAudience: string | undefined;

  beforeAll(async () => {
    savedSecret = process.env.JWT_SECRET;
    savedIssuer = process.env.JWT_ISSUER;
    savedAudience = process.env.JWT_AUDIENCE;
    process.env.JWT_SECRET = TEST_SECRET;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    configService.refresh();
    await flushMicrotasks(20);

    [aliceToken, bobToken, user1Token, user2Token, user3Token, adminToken] =
      await Promise.all([
        makeToken({ sub: "alice", role: "professional" }),
        makeToken({ sub: "bob", role: "professional" }),
        makeToken({ sub: "user-1", role: "customer" }),
        makeToken({ sub: "user-2", role: "customer" }),
        makeToken({ sub: "user-3", role: "customer" }),
        makeToken({ sub: "root", role: "admin" }),
      ]);

    app = createApp({ enableDocs: false });
  });

  afterAll(async () => {
    if (savedSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = savedSecret;
    if (savedIssuer === undefined) delete process.env.JWT_ISSUER;
    else process.env.JWT_ISSUER = savedIssuer;
    if (savedAudience === undefined) delete process.env.JWT_AUDIENCE;
    else process.env.JWT_AUDIENCE = savedAudience;
    configService.refresh();
    await flushMicrotasks(20);
  });

  function get(url: string, token?: string) {
    const req = request(app).get(url);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  }

  function post(url: string, token?: string, body: Record<string, unknown> = {}) {
    const req = request(app).post(url);
    if (token) req.set("Authorization", `Bearer ${token}`);
    return req.send(body);
  }

  function del(url: string, token?: string) {
    const req = request(app).delete(url);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  }

  async function createProduct(token: string, professional: string): Promise<string> {
    const res = await post("/api/v1/subscriptions/products", token, productBody(professional));
    expect(res.status).toBe(201);
    return res.body.data.id;
  }

  async function createSubscription(
    productId: string,
    token: string,
    body: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await post("/api/v1/subscriptions", token, { productId, ...body });
    expect(res.status).toBe(201);
    return res.body.data.id;
  }

  // ── Anonymous access ──────────────────────────────────────────────────────

  it("returns 401 for anonymous requests to every route", async () => {
    const anonymousCalls: Array<() => request.Test> = [
      () => post("/api/v1/subscriptions/products", undefined, productBody("alice")),
      () => get("/api/v1/subscriptions/products"),
      () => get("/api/v1/subscriptions/products/prod-x"),
      () => del("/api/v1/subscriptions/products/prod-x"),
      () => post("/api/v1/subscriptions", undefined, { productId: "prod-x" }),
      () => get("/api/v1/subscriptions/sub-x"),
      () => get("/api/v1/subscriptions"),
      () => post("/api/v1/subscriptions/sub-x/pause"),
      () => post("/api/v1/subscriptions/sub-x/resume"),
      () => post("/api/v1/subscriptions/sub-x/cancel"),
    ];

    for (const call of anonymousCalls) {
      const res = await call();
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    }
  });

  it("regression: an anonymous cancel succeeded on main (issue #1311)", async () => {
    const productId = await createProduct(aliceToken, "alice");
    const subId = await createSubscription(productId, user1Token);

    // On main this returns 200 — any anonymous caller could cancel anyone's
    // subscription. With auth it must be 401 and leave the subscription
    // untouched.
    const cancelRes = await post(`/api/v1/subscriptions/${subId}/cancel`);
    expect(cancelRes.status).toBe(401);

    const asOwner = await get(`/api/v1/subscriptions/${subId}`, user1Token);
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.data.status).toBe("active");
  });

  // ── POST /products ────────────────────────────────────────────────────────

  describe("POST /products", () => {
    it("allows a professional to create a product for themselves (owner)", async () => {
      const res = await post("/api/v1/subscriptions/products", aliceToken, productBody("alice"));
      expect(res.status).toBe(201);
      expect(res.body.data.professional).toBe("alice");
    });

    it("rejects a professional creating a product for another professional (other → 403)", async () => {
      const res = await post("/api/v1/subscriptions/products", bobToken, productBody("alice"));
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("rejects a customer creating products (role → 403)", async () => {
      const res = await post("/api/v1/subscriptions/products", user1Token, productBody("user-1"));
      expect(res.status).toBe(403);
    });

    it("allows an admin to create a product for any professional (admin)", async () => {
      const res = await post("/api/v1/subscriptions/products", adminToken, productBody("alice"));
      expect(res.status).toBe(201);
      expect(res.body.data.professional).toBe("alice");
    });
  });

  // ── GET /products ─────────────────────────────────────────────────────────

  describe("GET /products", () => {
    it("allows any authenticated caller (owner/other/admin → 200)", async () => {
      await createProduct(aliceToken, "alice");

      for (const token of [aliceToken, bobToken, user1Token, adminToken]) {
        const res = await get("/api/v1/subscriptions/products", token);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      }
    });
  });

  // ── GET /products/:productId ──────────────────────────────────────────────

  describe("GET /products/:productId", () => {
    it("allows any authenticated caller to read a product (owner/other/admin → 200)", async () => {
      const productId = await createProduct(aliceToken, "alice");

      for (const token of [aliceToken, bobToken, user1Token, adminToken]) {
        const res = await get(`/api/v1/subscriptions/products/${productId}`, token);
        expect(res.status).toBe(200);
        expect(res.body.data.id).toBe(productId);
      }
    });
  });

  // ── DELETE /products/:productId ───────────────────────────────────────────

  describe("DELETE /products/:productId", () => {
    it("allows the owning professional to deactivate their product (owner)", async () => {
      const productId = await createProduct(aliceToken, "alice");

      const res = await del(`/api/v1/subscriptions/products/${productId}`, aliceToken);
      expect(res.status).toBe(200);
      expect(res.body.data.active).toBe(false);
    });

    it("rejects another professional deactivating the product (other → 403, AC)", async () => {
      const productId = await createProduct(aliceToken, "alice");

      const res = await del(`/api/v1/subscriptions/products/${productId}`, bobToken);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);

      // The product must remain active after the rejected attempt.
      const ownerRead = await get(`/api/v1/subscriptions/products/${productId}`, aliceToken);
      expect(ownerRead.body.data.active).toBe(true);
    });

    it("rejects a customer deactivating any product (role → 403)", async () => {
      const productId = await createProduct(aliceToken, "alice");

      const res = await del(`/api/v1/subscriptions/products/${productId}`, user1Token);
      expect(res.status).toBe(403);
    });

    it("allows an admin to deactivate any product (admin)", async () => {
      const productId = await createProduct(aliceToken, "alice");

      const res = await del(`/api/v1/subscriptions/products/${productId}`, adminToken);
      expect(res.status).toBe(200);
      expect(res.body.data.active).toBe(false);
    });
  });

  // ── POST / (subscribe) ────────────────────────────────────────────────────

  describe("POST / (subscribe)", () => {
    it("subscribes the caller when subscriberId matches the token (owner)", async () => {
      const productId = await createProduct(aliceToken, "alice");

      const res = await post("/api/v1/subscriptions", user1Token, {
        productId,
        subscriberId: "user-1",
      });
      expect(res.status).toBe(201);
      expect(res.body.data.subscriberId).toBe("user-1");
    });

    it("derives subscriberId from the token when the body omits it (AC)", async () => {
      const productId = await createProduct(aliceToken, "alice");

      const res = await post("/api/v1/subscriptions", user2Token, { productId });
      expect(res.status).toBe(201);
      expect(res.body.data.subscriberId).toBe("user-2");
    });

    it("rejects a subscriberId that differs from the caller (AC)", async () => {
      const productId = await createProduct(aliceToken, "alice");

      const res = await post("/api/v1/subscriptions", user1Token, {
        productId,
        subscriberId: "user-2",
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("subscriberId");
    });

    it("rejects even an admin subscribing with a foreign subscriberId", async () => {
      const productId = await createProduct(aliceToken, "alice");

      const res = await post("/api/v1/subscriptions", adminToken, {
        productId,
        subscriberId: "user-1",
      });
      expect(res.status).toBe(403);
    });
  });

  // ── GET /:subscriptionId ──────────────────────────────────────────────────

  describe("GET /:subscriptionId", () => {
    it("allows the subscriber, the product's professional, and admin", async () => {
      const productId = await createProduct(aliceToken, "alice");
      const subId = await createSubscription(productId, user1Token);

      for (const token of [user1Token, aliceToken, adminToken]) {
        const res = await get(`/api/v1/subscriptions/${subId}`, token);
        expect(res.status).toBe(200);
        expect(res.body.data.id).toBe(subId);
      }
    });

    it("rejects an uninvolved caller (other → 403)", async () => {
      const productId = await createProduct(aliceToken, "alice");
      const subId = await createSubscription(productId, user1Token);

      const res = await get(`/api/v1/subscriptions/${subId}`, user2Token);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });

  // ── GET / (list) ──────────────────────────────────────────────────────────

  describe("GET / (list)", () => {
    it("scopes results to the caller and lets admins see everything", async () => {
      const productId = await createProduct(aliceToken, "alice");
      await createSubscription(productId, user1Token);
      await createSubscription(productId, user2Token);
      const url = `/api/v1/subscriptions?productId=${productId}`;

      const asUser1 = await get(url, user1Token);
      expect(asUser1.status).toBe(200);
      expect(asUser1.body.data).toHaveLength(1);
      expect(asUser1.body.data[0].subscriberId).toBe("user-1");

      const asUser3 = await get(url, user3Token);
      expect(asUser3.status).toBe(200);
      expect(asUser3.body.data).toHaveLength(0);

      // The product's professional owns both subscriptions.
      const asAlice = await get(url, aliceToken);
      expect(asAlice.status).toBe(200);
      expect(asAlice.body.data).toHaveLength(2);

      const asAdmin = await get(url, adminToken);
      expect(asAdmin.status).toBe(200);
      expect(asAdmin.body.data).toHaveLength(2);
    });
  });

  // ── POST /:subscriptionId/pause ───────────────────────────────────────────

  describe("POST /:subscriptionId/pause", () => {
    it("allows the subscriber to pause (owner)", async () => {
      const productId = await createProduct(aliceToken, "alice");
      const subId = await createSubscription(productId, user1Token);

      const res = await post(`/api/v1/subscriptions/${subId}/pause`, user1Token);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("paused");
    });

    it("rejects user A pausing user B's subscription (other → 403, AC)", async () => {
      const productId = await createProduct(aliceToken, "alice");
      const subId = await createSubscription(productId, user1Token);

      const res = await post(`/api/v1/subscriptions/${subId}/pause`, user2Token);
      expect(res.status).toBe(403);

      // Not mutated by the rejected attempt.
      const asOwner = await get(`/api/v1/subscriptions/${subId}`, user1Token);
      expect(asOwner.body.data.status).toBe("active");
    });

    it("allows admin to pause any subscription (admin)", async () => {
      const productId = await createProduct(aliceToken, "alice");
      const subId = await createSubscription(productId, user1Token);

      const res = await post(`/api/v1/subscriptions/${subId}/pause`, adminToken);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("paused");
    });
  });

  // ── POST /:subscriptionId/resume ──────────────────────────────────────────

  describe("POST /:subscriptionId/resume", () => {
    it("allows the subscriber to resume a paused subscription (owner)", async () => {
      const productId = await createProduct(aliceToken, "alice");
      const subId = await createSubscription(productId, user1Token);
      await post(`/api/v1/subscriptions/${subId}/pause`, user1Token);

      const res = await post(`/api/v1/subscriptions/${subId}/resume`, user1Token);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("active");
    });

    it("rejects user A resuming user B's subscription (other → 403)", async () => {
      const productId = await createProduct(aliceToken, "alice");
      const subId = await createSubscription(productId, user1Token);
      await post(`/api/v1/subscriptions/${subId}/pause`, user1Token);

      const res = await post(`/api/v1/subscriptions/${subId}/resume`, user2Token);
      expect(res.status).toBe(403);

      const asOwner = await get(`/api/v1/subscriptions/${subId}`, user1Token);
      expect(asOwner.body.data.status).toBe("paused");
    });

    it("allows admin to resume any paused subscription (admin)", async () => {
      const productId = await createProduct(aliceToken, "alice");
      const subId = await createSubscription(productId, user1Token);
      await post(`/api/v1/subscriptions/${subId}/pause`, user1Token);

      const res = await post(`/api/v1/subscriptions/${subId}/resume`, adminToken);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("active");
    });
  });

  // ── POST /:subscriptionId/cancel ──────────────────────────────────────────

  describe("POST /:subscriptionId/cancel", () => {
    it("allows the subscriber to cancel (owner)", async () => {
      const productId = await createProduct(aliceToken, "alice");
      const subId = await createSubscription(productId, user1Token);

      const res = await post(`/api/v1/subscriptions/${subId}/cancel`, user1Token);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("cancelled");
    });

    it("rejects user A cancelling user B's subscription (other → 403, AC)", async () => {
      const productId = await createProduct(aliceToken, "alice");
      const subId = await createSubscription(productId, user1Token);

      const res = await post(`/api/v1/subscriptions/${subId}/cancel`, user2Token);
      expect(res.status).toBe(403);

      const asOwner = await get(`/api/v1/subscriptions/${subId}`, user1Token);
      expect(asOwner.body.data.status).toBe("active");
    });

    it("allows admin to cancel any subscription (admin)", async () => {
      const productId = await createProduct(aliceToken, "alice");
      const subId = await createSubscription(productId, user1Token);

      const res = await post(`/api/v1/subscriptions/${subId}/cancel`, adminToken);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("cancelled");
    });

    it("still returns 404 for an unknown subscription when authenticated", async () => {
      const res = await post("/api/v1/subscriptions/nonexistent/cancel", user1Token);
      expect(res.status).toBe(404);
    });
  });
});
