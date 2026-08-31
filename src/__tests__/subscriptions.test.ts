import request from "supertest";
import { createApp } from "../app.js";

describe("Subscription Routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp({ enableDocs: false });
  });

  function post(path: string, body: Record<string, unknown>) {
    return request(app)
      .post(path)
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

      const res = await request(app).get("/api/v1/subscriptions/products");
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

      const res = await request(app).get("/api/v1/subscriptions/products?professional=alice");
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
      const res = await request(app).get(`/api/v1/subscriptions/products/${productId}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(productId);
    });

    it("returns 404 for unknown product", async () => {
      const res = await request(app).get("/api/v1/subscriptions/products/nonexistent");
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
      const res = await request(app).delete(`/api/v1/subscriptions/products/${productId}`);

      expect(res.status).toBe(200);
      expect(res.body.data.active).toBe(false);
    });

    it("returns 404 for unknown product", async () => {
      const res = await request(app).delete("/api/v1/subscriptions/products/nonexistent");
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

    it("returns 400 for missing subscriberId", async () => {
      const res = await post("/api/v1/subscriptions", { productId: "test" });
      expect(res.status).toBe(400);
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
      const res = await request(app).get(`/api/v1/subscriptions/${subId}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(subId);
    });

    it("returns 404 for unknown subscription", async () => {
      const res = await request(app).get("/api/v1/subscriptions/nonexistent");
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
