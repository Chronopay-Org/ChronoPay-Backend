import request from "supertest";
import { SignJWT } from "jose";
import { createApp } from "../app.js";
import { configService } from "../config/config.service.js";
import { flushMicrotasks } from "../test-helpers/fakeMfaRepository.js";

const TEST_SECRET = "subscriptions-test-secret-32chars-ok!";

async function makeToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(TEST_SECRET));
}

describe("Subscription Routes", () => {
  let app: ReturnType<typeof createApp>;
  let aliceToken: string; // professional alice — owns the products
  let userToken: string; // customer user-1 — the subscriber
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

    aliceToken = await makeToken({ sub: "alice", role: "professional" });
    userToken = await makeToken({ sub: "user-1", role: "customer" });
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

  /** Picks the caller by endpoint family: product routes act as alice,
   *  subscription routes act as the subscriber user-1 (issue #1311). */
  function tokenFor(path: string): string {
    return path === "/api/v1/subscriptions/products" ? aliceToken : userToken;
  }

  function post(path: string, body: Record<string, unknown>, token?: string) {
    return request(app)
      .post(path)
      .set("Authorization", `Bearer ${token ?? tokenFor(path)}`)
      .set("Content-Type", "application/json")
      .send(body);
  }

  // ── Product Endpoints ────────────────────────────────────────────────────

  describe("POST /api/v1/subscriptions/products", () => {
    it("creates a subscription product", async () => {
      const res = await post("/api/v1/subscriptions/products", {
        name: "Weekly Yoga",
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.name).toBe("Weekly Yoga");
    });

    it("returns 400 for missing name", async () => {
      const res = await post("/api/v1/subscriptions/products", {
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("returns 400 for missing professional", async () => {
      const res = await post("/api/v1/subscriptions/products", {
        name: "Test",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("returns 400 for invalid slotDurationMs", async () => {
      const res = await post("/api/v1/subscriptions/products", {
        name: "Test",
        professional: "alice",
        slotDurationMs: -1,
        recurrenceRule: "FREQ=DAILY",
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("returns 400 for missing recurrenceRule", async () => {
      const res = await post("/api/v1/subscriptions/products", {
        name: "Test",
        professional: "alice",
        slotDurationMs: 3_600_000,
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe("GET /api/v1/subscriptions/products", () => {
    it("lists products", async () => {
      await post("/api/v1/subscriptions/products", {
        name: "Listed Product",
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
      });

      const res = await request(app)
        .get("/api/v1/subscriptions/products")
        .set("Authorization", `Bearer ${aliceToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it("filters by professional", async () => {
      await post("/api/v1/subscriptions/products", {
        name: "Alice Filtered",
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
      });

      const res = await request(app)
        .get("/api/v1/subscriptions/products?professional=alice")
        .set("Authorization", `Bearer ${aliceToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.every((p: any) => p.professional === "alice")).toBe(true);
    });
  });

  describe("GET /api/v1/subscriptions/products/:productId", () => {
    it("returns a product by id", async () => {
      const createRes = await post("/api/v1/subscriptions/products", {
        name: "Get Me",
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
      });

      const productId = createRes.body.data.id;
      const res = await request(app)
        .get(`/api/v1/subscriptions/products/${productId}`)
        .set("Authorization", `Bearer ${aliceToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(productId);
    });

    it("returns 404 for unknown product", async () => {
      const res = await request(app)
        .get("/api/v1/subscriptions/products/nonexistent")
        .set("Authorization", `Bearer ${aliceToken}`);
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  describe("DELETE /api/v1/subscriptions/products/:productId", () => {
    it("deactivates a product", async () => {
      const createRes = await post("/api/v1/subscriptions/products", {
        name: "To Deactivate",
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
      });

      const productId = createRes.body.data.id;
      const res = await request(app)
        .delete(`/api/v1/subscriptions/products/${productId}`)
        .set("Authorization", `Bearer ${aliceToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.active).toBe(false);
    });

    it("returns 404 for unknown product", async () => {
      const res = await request(app)
        .delete("/api/v1/subscriptions/products/nonexistent")
        .set("Authorization", `Bearer ${aliceToken}`);
      expect(res.status).toBe(404);
    });
  });

  // ── Subscription Endpoints ──────────────────────────────────────────────

  describe("POST /api/v1/subscriptions", () => {
    it("creates a subscription", async () => {
      const productRes = await post("/api/v1/subscriptions/products", {
        name: "Subscribable",
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
      });

      const productId = productRes.body.data.id;

      const res = await post("/api/v1/subscriptions", { productId, subscriberId: "user-1" });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.productId).toBe(productId);
      expect(res.body.data.subscriberId).toBe("user-1");
      expect(res.body.data.status).toBe("active");
    });

    it("returns 400 for missing productId", async () => {
      const res = await post("/api/v1/subscriptions", { subscriberId: "user-1" });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("derives subscriberId from the authenticated caller when absent (issue #1311)", async () => {
      const productRes = await post("/api/v1/subscriptions/products", {
        name: "Token Subscriber",
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
      });

      const res = await post("/api/v1/subscriptions", {
        productId: productRes.body.data.id,
      });

      expect(res.status).toBe(201);
      expect(res.body.data.subscriberId).toBe("user-1");
    });

    it("rejects a subscriberId that differs from the caller (issue #1311)", async () => {
      const productRes = await post("/api/v1/subscriptions/products", {
        name: "Mismatch Subscriber",
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
      });

      const res = await post("/api/v1/subscriptions", {
        productId: productRes.body.data.id,
        subscriberId: "user-2",
      });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("returns 404 for unknown product", async () => {
      const res = await post("/api/v1/subscriptions", { productId: "nonexistent", subscriberId: "user-1" });
      expect(res.status).toBe(404);
    });

    it("returns 409 for duplicate subscription", async () => {
      const productRes = await post("/api/v1/subscriptions/products", {
        name: "Dup Test",
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
      });

      const productId = productRes.body.data.id;

      await post("/api/v1/subscriptions", { productId, subscriberId: "user-1" });
      const res = await post("/api/v1/subscriptions", { productId, subscriberId: "user-1" });

      expect(res.status).toBe(409);
    });
  });

  describe("GET /api/v1/subscriptions/:subscriptionId", () => {
    it("returns a subscription", async () => {
      const productRes = await post("/api/v1/subscriptions/products", {
        name: "For Get",
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
      });

      const subRes = await post("/api/v1/subscriptions", {
        productId: productRes.body.data.id,
        subscriberId: "user-1",
      });

      const subId = subRes.body.data.id;
      const res = await request(app)
        .get(`/api/v1/subscriptions/${subId}`)
        .set("Authorization", `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(subId);
    });

    it("returns 404 for unknown subscription", async () => {
      const res = await request(app)
        .get("/api/v1/subscriptions/nonexistent")
        .set("Authorization", `Bearer ${userToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/v1/subscriptions/:subscriptionId/pause", () => {
    it("pauses a subscription", async () => {
      const productRes = await post("/api/v1/subscriptions/products", {
        name: "Pausable",
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
      });

      const subRes = await post("/api/v1/subscriptions", {
        productId: productRes.body.data.id,
        subscriberId: "user-1",
      });

      const subId = subRes.body.data.id;
      const res = await post(`/api/v1/subscriptions/${subId}/pause`, {});

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("paused");
    });

    it("returns 409 for already paused", async () => {
      const productRes = await post("/api/v1/subscriptions/products", {
        name: "Already Paused",
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
      });

      const subRes = await post("/api/v1/subscriptions", {
        productId: productRes.body.data.id,
        subscriberId: "user-1",
      });

      const subId = subRes.body.data.id;
      await post(`/api/v1/subscriptions/${subId}/pause`, {});
      const res = await post(`/api/v1/subscriptions/${subId}/pause`, {});

      expect(res.status).toBe(409);
    });
  });

  describe("POST /api/v1/subscriptions/:subscriptionId/resume", () => {
    it("resumes a paused subscription", async () => {
      const productRes = await post("/api/v1/subscriptions/products", {
        name: "Resumable",
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
      });

      const subRes = await post("/api/v1/subscriptions", {
        productId: productRes.body.data.id,
        subscriberId: "user-1",
      });

      const subId = subRes.body.data.id;
      await post(`/api/v1/subscriptions/${subId}/pause`, {});
      const res = await post(`/api/v1/subscriptions/${subId}/resume`, {});

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("active");
    });

    it("returns 409 for active subscription", async () => {
      const productRes = await post("/api/v1/subscriptions/products", {
        name: "Not Paused",
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
      });

      const subRes = await post("/api/v1/subscriptions", {
        productId: productRes.body.data.id,
        subscriberId: "user-1",
      });

      const subId = subRes.body.data.id;
      const res = await post(`/api/v1/subscriptions/${subId}/resume`, {});

      expect(res.status).toBe(409);
    });
  });

  describe("POST /api/v1/subscriptions/:subscriptionId/cancel", () => {
    it("cancels a subscription", async () => {
      const productRes = await post("/api/v1/subscriptions/products", {
        name: "Cancellable",
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
      });

      const subRes = await post("/api/v1/subscriptions", {
        productId: productRes.body.data.id,
        subscriberId: "user-1",
      });

      const subId = subRes.body.data.id;
      const res = await post(`/api/v1/subscriptions/${subId}/cancel`, {});

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("cancelled");
      expect(res.body.data.cancelledAt).toBeDefined();
    });

    it("returns 409 for already cancelled", async () => {
      const productRes = await post("/api/v1/subscriptions/products", {
        name: "Double Cancel",
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
      });

      const subRes = await post("/api/v1/subscriptions", {
        productId: productRes.body.data.id,
        subscriberId: "user-1",
      });

      const subId = subRes.body.data.id;
      await post(`/api/v1/subscriptions/${subId}/cancel`, {});
      const res = await post(`/api/v1/subscriptions/${subId}/cancel`, {});

      expect(res.status).toBe(409);
    });

    it("returns 404 for unknown subscription", async () => {
      const res = await post("/api/v1/subscriptions/nonexistent/cancel", {});
      expect(res.status).toBe(404);
    });
  });
});
