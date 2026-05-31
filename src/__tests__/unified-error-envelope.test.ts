import express from "express";
import request from "supertest";
import { BadRequestError } from "../errors/AppError.js";
import { genericErrorHandler } from "../middleware/errorHandling.js";
import { createBookingIntentsRouter } from "../routes/booking-intents.js";
import checkoutRouter from "../routes/checkout.js";
import slotsRouter from "../routes/slots.js";
import {
  featureFlagContextMiddleware,
  initializeFeatureFlagsFromEnv,
} from "../middleware/featureFlags.js";
import { createApp } from "../app.js";

describe("Unified error envelope", () => {
  it("AppError toJSON includes success, code, message, error, and timestamp", () => {
    const error = new BadRequestError("Invalid input provided");
    const envelope = error.toJSON();

    expect(envelope).toEqual(
      expect.objectContaining({
        success: false,
        code: "BAD_REQUEST",
        message: "Invalid input provided",
        error: "Invalid input provided",
        timestamp: expect.any(String),
      }),
    );
  });

  it("genericErrorHandler serializes AppError instances consistently", async () => {
    const app = express();
    app.get("/test", () => {
      throw new BadRequestError("Invalid path parameter");
    });
    app.use(genericErrorHandler);

    const response = await request(app).get("/test");

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        success: false,
        code: "BAD_REQUEST",
        message: "Invalid path parameter",
        error: "Invalid path parameter",
      }),
    );
    expect(response.body.timestamp).toBeDefined();
  });

  it("genericErrorHandler falls back to internal error envelope for unknown errors", async () => {
    const app = express();
    app.get("/fail", () => {
      throw new Error("unexpected");
    });
    app.use(genericErrorHandler);

    const response = await request(app).get("/fail");

    expect(response.status).toBe(500);
    expect(response.body).toEqual(
      expect.objectContaining({
        success: false,
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        error: "Internal server error",
      }),
    );
    expect(response.body.timestamp).toBeDefined();
  });

  it("genericErrorHandler sanitizes errors from /__test__/explode route", async () => {
    const app = createApp({ enableTestRoutes: true });

    const response = await request(app).get("/__test__/explode");

    expect(response.status).toBe(500);
    expect(response.body).toEqual(
      expect.objectContaining({
        success: false,
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        error: "Internal server error",
        timestamp: expect.any(String),
      }),
    );
    // Assert the raw error message and stack are not present in the response
    const responseBody = JSON.stringify(response.body);
    expect(responseBody).not.toContain("Intentional test fault");
    expect(responseBody).not.toContain("stack");
  });
});

describe("Route adapters using shared AppError envelope", () => {
  beforeEach(() => {
    process.env.FF_CREATE_BOOKING_INTENT = "true";
    process.env.FF_CHECKOUT = "true";
    initializeFeatureFlagsFromEnv();
  });

  it("booking-intents route returns unified envelope for business errors", async () => {
    const app = express();
    app.use(express.json());
    app.use(featureFlagContextMiddleware);
    app.use("/api/v1/booking-intents", createBookingIntentsRouter());
    app.use(genericErrorHandler);

    const response = await request(app)
      .post("/api/v1/booking-intents")
      .set("x-chronopay-user-id", "customer-1")
      .set("x-chronopay-role", "customer")
      .send({ slotId: "slot-00000000-0000-4000-8000-000000000000" });

    expect(response.status).toBe(404);
    expect(response.body).toEqual(
      expect.objectContaining({
        success: false,
        code: "NOT_FOUND",
        message: "Selected slot was not found.",
        error: "Selected slot was not found.",
      }),
    );
  });

  it("checkout route returns unified envelope for service errors", async () => {
    const app = express();
    app.use(express.json());
    app.use(featureFlagContextMiddleware);
    app.use("/api/v1/checkout", checkoutRouter);
    app.use(genericErrorHandler);

    const response = await request(app)
      .get("/api/v1/checkout/sessions/00000000-0000-0000-0000-000000000000");

    expect(response.status).toBe(404);
    expect(response.body).toEqual(
      expect.objectContaining({
        success: false,
        code: "SESSION_NOT_FOUND",
        message: "Session 00000000-0000-0000-0000-000000000000 not found",
        error: "Session 00000000-0000-0000-0000-000000000000 not found",
      }),
    );
  });

  it("slots route returns unified envelope for invalid id validation errors", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/v1/slots", slotsRouter);
    app.use(genericErrorHandler);

    const response = await request(app).get("/api/v1/slots/abc");

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        success: false,
        code: "BAD_REQUEST",
        message: "Invalid slot id",
        error: "Invalid slot id",
      }),
    );
  });
});
