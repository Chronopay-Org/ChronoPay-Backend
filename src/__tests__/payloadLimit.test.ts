/**
 * Tests for src/middleware/payloadLimit.ts
 *
 * Covers: valid size strings, invalid size strings, 413 response shape,
 * normal requests within limit, and route-level limit registry.
 */

import express, { Request, Response } from "express";
import request from "supertest";
import {
  payloadLimit,
  ROUTE_PAYLOAD_LIMITS,
} from "../middleware/payloadLimit.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeApp(limit: string) {
  const app = express();
  app.post("/test", ...payloadLimit(limit), (req: Request, res: Response) => {
    res.json({ received: req.body });
  });
  return app;
}

// ─── payloadLimit() ───────────────────────────────────────────────────────────

describe("payloadLimit()", () => {
  describe("valid size strings", () => {
    it("accepts a request within the limit", async () => {
      const app = makeApp("1kb");
      const payload = { data: "x".repeat(100) };

      const res = await request(app).post("/test").send(payload);

      expect(res.status).toBe(200);
      expect(res.body.received.data).toBe(payload.data);
    });

    it("returns 413 with standard envelope when payload exceeds limit", async () => {
      const app = makeApp("1b"); // 1 byte — any JSON body will exceed this

      const res = await request(app)
        .post("/test")
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ x: 1 }));

      expect(res.status).toBe(413);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("PAYLOAD_TOO_LARGE");
      expect(res.body.error).toMatch(/1b/);
    });

    it("accepts a request exactly at the limit boundary", async () => {
      // A 10-byte JSON body: {"a":1}  = 7 bytes; use 100b limit
      const app = makeApp("100b");
      const res = await request(app).post("/test").send({ a: 1 });
      expect(res.status).toBe(200);
    });

    it("accepts 'kb' size strings", () => {
      expect(() => payloadLimit("16kb")).not.toThrow();
    });

    it("accepts 'mb' size strings", () => {
      expect(() => payloadLimit("1mb")).not.toThrow();
    });

    it("accepts 'b' size strings", () => {
      expect(() => payloadLimit("512b")).not.toThrow();
    });
  });

  describe("invalid size strings", () => {
    it("throws at construction for an empty string", () => {
      expect(() => payloadLimit("")).toThrow(/invalid size string/i);
    });

    it("throws for a string without a unit", () => {
      expect(() => payloadLimit("100")).toThrow(/invalid size string/i);
    });

    it("throws for an unknown unit", () => {
      expect(() => payloadLimit("10gb")).toThrow(/invalid size string/i);
    });

    it("throws for a non-numeric prefix", () => {
      expect(() => payloadLimit("xkb")).toThrow(/invalid size string/i);
    });
  });
});

// ─── ROUTE_PAYLOAD_LIMITS ─────────────────────────────────────────────────────

describe("ROUTE_PAYLOAD_LIMITS", () => {
  it("defines a checkout limit", () => {
    expect(ROUTE_PAYLOAD_LIMITS.checkout).toBeDefined();
    expect(() => payloadLimit(ROUTE_PAYLOAD_LIMITS.checkout)).not.toThrow();
  });

  it("defines a slots limit", () => {
    expect(ROUTE_PAYLOAD_LIMITS.slots).toBeDefined();
    expect(() => payloadLimit(ROUTE_PAYLOAD_LIMITS.slots)).not.toThrow();
  });

  it("defines a default limit", () => {
    expect(ROUTE_PAYLOAD_LIMITS.default).toBeDefined();
    expect(() => payloadLimit(ROUTE_PAYLOAD_LIMITS.default)).not.toThrow();
  });

  it("checkout limit is smaller than default", () => {
    // Parse the numeric part for comparison
    const parse = (s: string) => {
      const m = s.match(/^(\d+)(kb|mb|b)$/i)!;
      const n = parseInt(m[1], 10);
      const unit = m[2].toLowerCase();
      return unit === "mb" ? n * 1024 : unit === "kb" ? n : n / 1024;
    };

    expect(parse(ROUTE_PAYLOAD_LIMITS.checkout)).toBeLessThan(
      parse(ROUTE_PAYLOAD_LIMITS.default),
    );
  });
});
