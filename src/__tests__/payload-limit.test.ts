import express from "express";
import request from "supertest";
import { payloadLimit, ROUTE_PAYLOAD_LIMITS } from "../middleware/payloadLimit.js";
import { createApp } from "../app.js";
import {
  featureFlagContextMiddleware,
  initializeFeatureFlagsFromEnv,
} from "../middleware/featureFlags.js";

describe("Payload limit middleware", () => {
  it("returns 413 with standard envelope when payload exceeds limit", async () => {
    const app = express();
    app.use(...payloadLimit("1kb"));
    app.post("/test", (req, res) => {
      res.json({ success: true });
    });

    // Create a payload larger than 1kb
    const largePayload = { data: "x".repeat(2048) };

    const response = await request(app)
      .post("/test")
      .send(largePayload);

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      success: false,
      code: "PAYLOAD_TOO_LARGE",
      error: "Request body exceeds the 1kb limit for this endpoint.",
    });
  });

  it("allows payloads within the limit", async () => {
    const app = express();
    app.use(...payloadLimit("16kb"));
    app.post("/test", (req, res) => {
      res.json({ success: true });
    });

    const smallPayload = { data: "hello" };

    const response = await request(app)
      .post("/test")
      .send(smallPayload);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
  });

  it("ROUTE_PAYLOAD_LIMITS contains all required entries", () => {
    expect(ROUTE_PAYLOAD_LIMITS).toHaveProperty("checkout");
    expect(ROUTE_PAYLOAD_LIMITS).toHaveProperty("slots");
    expect(ROUTE_PAYLOAD_LIMITS).toHaveProperty("bookingIntent");
    expect(ROUTE_PAYLOAD_LIMITS).toHaveProperty("default");

    expect(ROUTE_PAYLOAD_LIMITS.checkout).toBe("16kb");
    expect(ROUTE_PAYLOAD_LIMITS.slots).toBe("32kb");
    expect(ROUTE_PAYLOAD_LIMITS.bookingIntent).toBe("16kb");
    expect(ROUTE_PAYLOAD_LIMITS.default).toBe("100kb");
  });
});

describe("Slot POST route payload limit", () => {
  it("payloadLimit middleware is applied to slot route", async () => {
    // Verify the middleware is imported and used in the route file
    const slotsModule = await import("../routes/slots.js");
    const slotsSource = await import("fs").then(fs => fs.readFileSync("c:\\Users\\EMMA\\Desktop\\chronopay\\src\\routes\\slots.ts", "utf-8"));
    
    expect(slotsSource).toContain('payloadLimit');
    expect(slotsSource).toContain('ROUTE_PAYLOAD_LIMITS.slots');
  });
});

describe("Booking-intent POST route payload limit", () => {
  it("payloadLimit middleware is applied to booking-intent route", async () => {
    // Verify the middleware is imported and used in the route file
    const bookingIntentsSource = await import("fs").then(fs => fs.readFileSync("c:\\Users\\EMMA\\Desktop\\chronopay\\src\\routes\\booking-intents.ts", "utf-8"));
    
    expect(bookingIntentsSource).toContain('payloadLimit');
    expect(bookingIntentsSource).toContain('ROUTE_PAYLOAD_LIMITS.bookingIntent');
  });
});
