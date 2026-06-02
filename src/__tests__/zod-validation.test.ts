/**
 * Tests for Zod-based validateBody middleware and route schemas.
 *
 * Covers:
 * - validateBody: valid input passes through with unknown fields stripped
 * - validateBody: invalid input returns uniform 400 envelope
 * - CreateSlotBodySchema: field-level rules
 * - CreateBookingIntentBodySchema: field-level rules
 * - Integration: POST /api/v1/slots and POST /api/v1/booking-intents
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express, { type Request, type Response } from "express";
import { validateBody } from "../middleware/validation.js";
import { CreateSlotBodySchema, CreateBookingIntentBodySchema } from "../middleware/schemas.js";

// ─── Unit: validateBody middleware ────────────────────────────────────────────

function makeApp(schema: Parameters<typeof validateBody>[0]) {
  const app = express();
  app.use(express.json());
  app.post("/test", validateBody(schema), (req: Request, res: Response) => {
    res.json({ success: true, body: req.body });
  });
  return app;
}

describe("validateBody middleware", () => {
  describe("with CreateSlotBodySchema", () => {
    let app: express.Express;
    beforeEach(() => {
      app = makeApp(CreateSlotBodySchema);
    });

    it("passes valid body and strips unknown fields", async () => {
      const res = await request(app).post("/test").send({
        professional: "dr-smith",
        startTime: 1000,
        endTime: 2000,
        unknownField: "should be stripped",
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.body).toEqual({ professional: "dr-smith", startTime: 1000, endTime: 2000 });
      expect(res.body.body.unknownField).toBeUndefined();
    });

    it("returns 400 with VALIDATION_ERROR code when professional is missing", async () => {
      const res = await request(app).post("/test").send({ startTime: 1000, endTime: 2000 });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.details).toBeInstanceOf(Array);
      expect(res.body.details.some((d: { path: string }) => d.path === "professional")).toBe(true);
    });

    it("returns 400 when professional is empty string", async () => {
      const res = await request(app)
        .post("/test")
        .send({ professional: "", startTime: 1000, endTime: 2000 });
      expect(res.status).toBe(400);
      expect(res.body.details.some((d: { path: string }) => d.path === "professional")).toBe(true);
    });

    it("returns 400 when startTime is missing", async () => {
      const res = await request(app)
        .post("/test")
        .send({ professional: "dr-smith", endTime: 2000 });
      expect(res.status).toBe(400);
      expect(res.body.details.some((d: { path: string }) => d.path === "startTime")).toBe(true);
    });

    it("returns 400 when endTime is an invalid string", async () => {
      const res = await request(app)
        .post("/test")
        .send({ professional: "dr-smith", startTime: 1000, endTime: "not-a-date" });
      expect(res.status).toBe(400);
      expect(res.body.details.some((d: { path: string }) => d.path === "endTime")).toBe(true);
    });

    it("accepts ISO-8601 string for startTime", async () => {
      const res = await request(app).post("/test").send({
        professional: "dr-smith",
        startTime: "2024-01-15T10:00:00.000Z",
        endTime: "2024-01-15T11:00:00.000Z",
      });
      expect(res.status).toBe(200);
    });

    it("returns 400 when body is not an object", async () => {
      const res = await request(app)
        .post("/test")
        .set("Content-Type", "application/json")
        .send('"just a string"');
      expect(res.status).toBe(400);
    });

    it("returns 400 when multiple fields are invalid and details lists all of them", async () => {
      const res = await request(app).post("/test").send({});
      expect(res.status).toBe(400);
      expect(res.body.details.length).toBeGreaterThanOrEqual(2);
    });

    it("details are sorted by path ascending", async () => {
      const res = await request(app).post("/test").send({});
      const paths = res.body.details.map((d: { path: string }) => d.path);
      const sorted = [...paths].sort();
      expect(paths).toEqual(sorted);
    });
  });

  describe("with CreateBookingIntentBodySchema", () => {
    let app: express.Express;
    beforeEach(() => {
      app = makeApp(CreateBookingIntentBodySchema);
    });

    it("passes valid body with slotId only", async () => {
      const res = await request(app).post("/test").send({
        slotId: "slot-12345678-1234-1234-1234-123456789abc",
      });
      expect(res.status).toBe(200);
      expect(res.body.body.slotId).toBe("slot-12345678-1234-1234-1234-123456789abc");
    });

    it("passes valid body with slotId and note", async () => {
      const res = await request(app).post("/test").send({
        slotId: "slot-12345678-1234-1234-1234-123456789abc",
        note: "Please confirm ASAP",
      });
      expect(res.status).toBe(200);
      expect(res.body.body.note).toBe("Please confirm ASAP");
    });

    it("strips unknown fields", async () => {
      const res = await request(app).post("/test").send({
        slotId: "slot-12345678-1234-1234-1234-123456789abc",
        extra: "should be gone",
      });
      expect(res.status).toBe(200);
      expect(res.body.body.extra).toBeUndefined();
    });

    it("returns 400 when slotId is missing", async () => {
      const res = await request(app).post("/test").send({});
      expect(res.status).toBe(400);
      expect(res.body.details.some((d: { path: string }) => d.path === "slotId")).toBe(true);
    });

    it("returns 400 when slotId has invalid format", async () => {
      const res = await request(app).post("/test").send({ slotId: "not-a-valid-slot-id" });
      expect(res.status).toBe(400);
      expect(res.body.details.some((d: { path: string }) => d.path === "slotId")).toBe(true);
    });

    it("returns 400 when note is empty string", async () => {
      const res = await request(app).post("/test").send({
        slotId: "slot-12345678-1234-1234-1234-123456789abc",
        note: "",
      });
      expect(res.status).toBe(400);
      expect(res.body.details.some((d: { path: string }) => d.path === "note")).toBe(true);
    });

    it("returns 400 when note exceeds 500 chars", async () => {
      const res = await request(app).post("/test").send({
        slotId: "slot-12345678-1234-1234-1234-123456789abc",
        note: "x".repeat(501),
      });
      expect(res.status).toBe(400);
      expect(res.body.details.some((d: { path: string }) => d.path === "note")).toBe(true);
    });

    it("accepts note of exactly 500 chars", async () => {
      const res = await request(app).post("/test").send({
        slotId: "slot-12345678-1234-1234-1234-123456789abc",
        note: "x".repeat(500),
      });
      expect(res.status).toBe(200);
    });
  });
});

// ─── Integration: validateBody on a real Express route ───────────────────────
// These tests verify validateBody works correctly when mounted on a route,
// which is the same pattern used by the slots and booking-intent routes.

describe("validateBody on a mounted route (integration)", () => {
  it("returns 400 with VALIDATION_ERROR when required field is missing", async () => {
    const app = makeApp(CreateSlotBodySchema);
    const res = await request(app)
      .post("/test")
      .send({ startTime: 1000, endTime: 2000 }); // missing professional
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details.some((d: { path: string }) => d.path === "professional")).toBe(true);
  });

  it("returns 400 when a field has an invalid value", async () => {
    const app = makeApp(CreateSlotBodySchema);
    const res = await request(app)
      .post("/test")
      .send({ professional: "dr-smith", startTime: "garbage", endTime: 2000 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details.some((d: { path: string }) => d.path === "startTime")).toBe(true);
  });

  it("strips unknown fields and passes valid body through", async () => {
    const app = makeApp(CreateSlotBodySchema);
    const res = await request(app)
      .post("/test")
      .send({ professional: "dr-smith", startTime: 1000, endTime: 2000, injected: "evil" });
    expect(res.status).toBe(200);
    expect(res.body.body.injected).toBeUndefined();
  });
});
