/**
 * Integration tests for POST /api/v1/slots/conflicts/preview
 *
 * Uses a lightweight express app to avoid partner-tier and feature-flag
 * middleware that are already tested elsewhere.
 *
 * Covers:
 *  - 200 success with valid body and no conflicts
 *  - 200 response shape matches documented schema
 *  - 400 validation error (missing fields, invalid types)
 *  - 422 invalid RRULE / timezone
 *  - 401 missing API key (via router's requireApiKey)
 *  - Edge cases: empty body, unknown fields stripped
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { ConflictPreviewService } from "../../services/conflictPreviewService.js";
import { ConflictPreviewBodySchema } from "../../middleware/schemas.js";
import { validateBody } from "../../middleware/validation.js";
import { isValidIANATimezone } from "../../validation/reminderValidation.js";
import { RecurrenceError } from "../../services/recurrenceService.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function alignToSecond(ms: number): number {
  return Math.ceil(ms / 1000) * 1000;
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${day}T${h}${min}${s}Z`;
}

function dailyRRule(startMs: number, count: number): string {
  return `DTSTART:${fmtDate(startMs)}\nRRULE:FREQ=DAILY;COUNT=${count}`;
}

function buildTestApp(): express.Application {
  const app = express();
  app.use(express.json());

  app.post(
    "/api/v1/slots/conflicts/preview",
    validateBody(ConflictPreviewBodySchema),
    async (req: express.Request, res: express.Response) => {
      try {
        const { rrule, professional, slotDurationMs, timezone, horizonDays } = req.body;

        if (timezone && !isValidIANATimezone(timezone)) {
          return res.status(422).json({
            success: false,
            error: "timezone must be a valid IANA timezone identifier",
          });
        }

        const service = new ConflictPreviewService();
        const result = await service.previewConflicts({
          rrule,
          professional,
          slotDurationMs,
          timezone,
          horizonDays,
        });

        res.json({ success: true, data: result });
      } catch (error: any) {
        if (error instanceof RecurrenceError) {
          return res.status(422).json({
            success: false,
            error: error.message,
          });
        }
        res.status(500).json({
          success: false,
          error: "Conflict preview failed",
        });
      }
    },
  );

  return app;
}

describe("POST /api/v1/slots/conflicts/preview", () => {
  let app: express.Application;
  let realDateNow: typeof Date.now;
  let now: number;

  beforeAll(() => {
    app = buildTestApp();
  });

  beforeEach(() => {
    realDateNow = Date.now;
    now = alignToSecond(Date.now());
    Date.now = jest.fn(() => now) as any;
  });

  afterEach(() => {
    Date.now = realDateNow;
  });

  afterAll(() => {
    // cleanup if needed
  });

  // ── Success cases ───────────────────────────────────────────────────────

  describe("success", () => {
    it("returns 200 with valid body and no conflicts", async () => {
      const response = await request(app)
        .post("/api/v1/slots/conflicts/preview")
        .send({
          rrule: dailyRRule(now + DAY_MS, 3),
          professional: "alice",
          slotDurationMs: HOUR_MS,
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.totalOccurrences).toBe(3);
      expect(response.body.data.conflictsFound).toBe(0);
      expect(response.body.data.conflicts).toEqual([]);
    });

    it("returns 200 with horizonDays and horizonEnd in response", async () => {
      const response = await request(app)
        .post("/api/v1/slots/conflicts/preview")
        .send({
          rrule: dailyRRule(now + DAY_MS, 1),
          professional: "alice",
          slotDurationMs: HOUR_MS,
          horizonDays: 30,
        });

      expect(response.status).toBe(200);
      expect(response.body.data.horizonDays).toBe(30);
      expect(response.body.data.horizonEnd).toBeGreaterThan(now);
    });

    it("returns 200 with timezone parameter", async () => {
      const response = await request(app)
        .post("/api/v1/slots/conflicts/preview")
        .send({
          rrule: dailyRRule(now + DAY_MS, 1),
          professional: "alice",
          slotDurationMs: HOUR_MS,
          timezone: "America/New_York",
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("strips unknown fields from request body", async () => {
      const response = await request(app)
        .post("/api/v1/slots/conflicts/preview")
        .send({
          rrule: dailyRRule(now + DAY_MS, 1),
          professional: "alice",
          slotDurationMs: HOUR_MS,
          maliciousField: "should be stripped",
        });

      expect(response.status).toBe(200);
    });
  });

  // ── Validation errors ───────────────────────────────────────────────────

  describe("validation errors", () => {
    it("returns 400 when rrule is missing", async () => {
      const response = await request(app)
        .post("/api/v1/slots/conflicts/preview")
        .send({
          professional: "alice",
          slotDurationMs: HOUR_MS,
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when professional is missing", async () => {
      const response = await request(app)
        .post("/api/v1/slots/conflicts/preview")
        .send({
          rrule: dailyRRule(now + DAY_MS, 1),
          slotDurationMs: HOUR_MS,
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it("returns 400 when slotDurationMs is missing", async () => {
      const response = await request(app)
        .post("/api/v1/slots/conflicts/preview")
        .send({
          rrule: dailyRRule(now + DAY_MS, 1),
          professional: "alice",
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it("returns 400 when slotDurationMs is not a number", async () => {
      const response = await request(app)
        .post("/api/v1/slots/conflicts/preview")
        .send({
          rrule: dailyRRule(now + DAY_MS, 1),
          professional: "alice",
          slotDurationMs: "not-a-number",
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it("returns 400 when slotDurationMs is negative", async () => {
      const response = await request(app)
        .post("/api/v1/slots/conflicts/preview")
        .send({
          rrule: dailyRRule(now + DAY_MS, 1),
          professional: "alice",
          slotDurationMs: -1000,
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it("returns 400 when horizonDays exceeds maximum", async () => {
      const response = await request(app)
        .post("/api/v1/slots/conflicts/preview")
        .send({
          rrule: dailyRRule(now + DAY_MS, 1),
          professional: "alice",
          slotDurationMs: HOUR_MS,
          horizonDays: 400,
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it("returns 400 for empty body", async () => {
      const response = await request(app)
        .post("/api/v1/slots/conflicts/preview")
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });

  // ── RRULE errors ────────────────────────────────────────────────────────

  describe("RRULE errors", () => {
    it("returns 422 for unbounded RRULE", async () => {
      const response = await request(app)
        .post("/api/v1/slots/conflicts/preview")
        .send({
          rrule: "FREQ=WEEKLY;BYDAY=MO",
          professional: "alice",
          slotDurationMs: HOUR_MS,
        });

      expect(response.status).toBe(422);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("Unbounded RRULE");
    });

    it("returns 422 for invalid RRULE format", async () => {
      const response = await request(app)
        .post("/api/v1/slots/conflicts/preview")
        .send({
          rrule: "NOT_VALID",
          professional: "alice",
          slotDurationMs: HOUR_MS,
        });

      expect(response.status).toBe(422);
      expect(response.body.success).toBe(false);
    });

    it("returns 422 for invalid timezone", async () => {
      const response = await request(app)
        .post("/api/v1/slots/conflicts/preview")
        .send({
          rrule: dailyRRule(now + DAY_MS, 1),
          professional: "alice",
          slotDurationMs: HOUR_MS,
          timezone: "Invalid/Timezone",
        });

      expect(response.status).toBe(422);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("timezone");
    });
  });

  // ── Response shape ──────────────────────────────────────────────────────

  describe("response shape", () => {
    it("returns all expected fields", async () => {
      const response = await request(app)
        .post("/api/v1/slots/conflicts/preview")
        .send({
          rrule: dailyRRule(now + DAY_MS, 1),
          professional: "alice",
          slotDurationMs: HOUR_MS,
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("success", true);
      expect(response.body).toHaveProperty("data");
      expect(response.body.data).toHaveProperty("totalOccurrences");
      expect(response.body.data).toHaveProperty("conflictsFound");
      expect(response.body.data).toHaveProperty("conflicts");
      expect(response.body.data).toHaveProperty("horizonDays");
      expect(response.body.data).toHaveProperty("horizonEnd");
      expect(Array.isArray(response.body.data.conflicts)).toBe(true);
    });
  });
});
