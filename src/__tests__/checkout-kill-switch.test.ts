/**
 * Tests for the FF_CHECKOUT kill switch feature flag.
 *
 * Covers:
 * - Flag enabled: checkout routes respond normally.
 * - Flag disabled: all checkout routes return 503 with deterministic payload.
 * - Malformed flag value: resolveFeatureFlags throws at startup.
 * - Default value: CHECKOUT is enabled when FF_CHECKOUT is not set.
 */

import express from "express";
import request from "supertest";
import { featureFlagContextMiddleware } from "../middleware/featureFlags.js";
import { setFeatureFlagsFromEnv, resolveFeatureFlags } from "../flags/index.js";
import checkoutRouter from "../routes/checkout.js";
import { CheckoutSessionService } from "../services/checkout.js";

// ─── Minimal test app ─────────────────────────────────────────────────────────

function makeCheckoutApp() {
  const app = express();
  app.use(express.json());
  app.use(featureFlagContextMiddleware);
  app.use("/api/v1/checkout", checkoutRouter);
  return app;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_SESSION_PAYLOAD = {
  payment: {
    amount: 1000,
    currency: "USD",
    paymentMethod: "credit_card",
  },
  customer: {
    customerId: "cust_abc123",
    email: "test@example.com",
  },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("FF_CHECKOUT kill switch", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    CheckoutSessionService.clearAllSessions();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    setFeatureFlagsFromEnv(process.env);
  });

  // ── Default value ────────────────────────────────────────────────────────────

  describe("default value", () => {
    it("CHECKOUT flag defaults to true when FF_CHECKOUT is not set", () => {
      const state = resolveFeatureFlags({});
      expect(state.CHECKOUT).toBe(true);
    });
  });

  // ── Flag enabled ─────────────────────────────────────────────────────────────

  describe("when FF_CHECKOUT=true", () => {
    beforeEach(() => {
      setFeatureFlagsFromEnv({ ...process.env, FF_CHECKOUT: "true" });
    });

    it("POST /api/v1/checkout/sessions responds normally (201)", async () => {
      const app = makeCheckoutApp();
      const res = await request(app)
        .post("/api/v1/checkout/sessions")
        .send(VALID_SESSION_PAYLOAD);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it("GET /api/v1/checkout/sessions/:id responds normally (404 for unknown)", async () => {
      const app = makeCheckoutApp();
      const res = await request(app).get(
        "/api/v1/checkout/sessions/00000000-0000-0000-0000-000000000000",
      );

      // 404 is the expected response for an unknown session — not 503
      expect(res.status).not.toBe(503);
    });
  });

  // ── Flag disabled ─────────────────────────────────────────────────────────────

  describe("when FF_CHECKOUT=false", () => {
    beforeEach(() => {
      setFeatureFlagsFromEnv({ ...process.env, FF_CHECKOUT: "false" });
    });

    it("POST /api/v1/checkout/sessions returns 503", async () => {
      const app = makeCheckoutApp();
      const res = await request(app)
        .post("/api/v1/checkout/sessions")
        .send(VALID_SESSION_PAYLOAD);

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("FEATURE_DISABLED");
      expect(res.body.error).toMatch(/CHECKOUT/);
    });

    it("GET /api/v1/checkout/sessions/:id returns 503", async () => {
      const app = makeCheckoutApp();
      const res = await request(app).get(
        "/api/v1/checkout/sessions/00000000-0000-0000-0000-000000000000",
      );

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("FEATURE_DISABLED");
    });

    it("POST /api/v1/checkout/sessions/:id/complete returns 503", async () => {
      const app = makeCheckoutApp();
      const res = await request(app).post(
        "/api/v1/checkout/sessions/00000000-0000-0000-0000-000000000000/complete",
      );

      expect(res.status).toBe(503);
    });

    it("POST /api/v1/checkout/sessions/:id/cancel returns 503", async () => {
      const app = makeCheckoutApp();
      const res = await request(app).post(
        "/api/v1/checkout/sessions/00000000-0000-0000-0000-000000000000/cancel",
      );

      expect(res.status).toBe(503);
    });

    it("503 response body has the deterministic shape", async () => {
      const app = makeCheckoutApp();
      const res = await request(app)
        .post("/api/v1/checkout/sessions")
        .send(VALID_SESSION_PAYLOAD);

      expect(res.body).toMatchObject({
        success: false,
        code: "FEATURE_DISABLED",
        error: expect.stringContaining("CHECKOUT"),
      });
    });
  });

  // ── Malformed flag value ──────────────────────────────────────────────────────

  describe("malformed FF_CHECKOUT value", () => {
    it("throws at startup for an invalid value", () => {
      expect(() =>
        resolveFeatureFlags({ FF_CHECKOUT: "enabled" }),
      ).toThrow(/Invalid value for FF_CHECKOUT/);
    });

    it("throws for whitespace-only value", () => {
      expect(() =>
        resolveFeatureFlags({ FF_CHECKOUT: "   " }),
      ).toThrow(/Invalid value for FF_CHECKOUT/);
    });
  });

  // ── All truthy/falsy variants ─────────────────────────────────────────────────

  describe("accepted flag values", () => {
    it.each(["true", "1", "on", "yes"])(
      "enables CHECKOUT for value %s",
      (val) => {
        const state = resolveFeatureFlags({ FF_CHECKOUT: val });
        expect(state.CHECKOUT).toBe(true);
      },
    );

    it.each(["false", "0", "off", "no"])(
      "disables CHECKOUT for value %s",
      (val) => {
        const state = resolveFeatureFlags({ FF_CHECKOUT: val });
        expect(state.CHECKOUT).toBe(false);
      },
    );
  });
});
