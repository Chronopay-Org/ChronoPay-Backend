/**
 * Content Negotiation Middleware Tests
 *
 * Comprehensive test suite for Content-Type and Accept header enforcement.
 * Covers all edge cases, charset variants, missing headers, webhook exclusions,
 * and integration with the Express app.
 */

import request from "supertest";
import { createApp, type AppFactoryOptions } from "../app.js";
import express, { Express, Request, Response, NextFunction } from "express";
import { createContentNegotiationMiddleware } from "../middleware/contentNegotiation.js";
import { genericErrorHandler } from "../middleware/errorHandling.js";

describe("Content Negotiation Middleware - Unit Tests", () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(createContentNegotiationMiddleware());
    app.post("/test", (req, res) => {
      res.json({ success: true });
    });
    app.get("/test", (req, res) => {
      res.json({ success: true });
    });
    app.options("/test", (req, res) => {
      res.sendStatus(200);
    });
    app.patch("/test", (req, res) => {
      res.json({ success: true });
    });
    app.put("/test", (req, res) => {
      res.json({ success: true });
    });
    app.delete("/test", (req, res) => {
      res.json({ success: true });
    });

    // Register error handler
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      if (err && err.statusCode && (err.statusCode === 415 || err.statusCode === 406)) {
        return res.status(err.statusCode).json({
          success: false,
          code: err.code,
          error: err.message,
        });
      }
      return res.status(500).json({ success: false, error: "Internal server error" });
    });
  });

  describe("Content-Type Validation (POST/PUT/PATCH)", () => {
    it("should accept application/json Content-Type on POST", async () => {
      const res = await request(app)
        .post("/test")
        .set("Content-Type", "application/json")
        .send({ data: "test" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("should accept application/json with charset on POST", async () => {
      const res = await request(app)
        .post("/test")
        .set("Content-Type", "application/json; charset=utf-8")
        .send({ data: "test" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("should reject non-JSON Content-Type on POST with 415", async () => {
      const res = await request(app)
        .post("/test")
        .set("Content-Type", "text/plain")
        .send("test");

      expect(res.status).toBe(415);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("UNSUPPORTED_MEDIA_TYPE");
      expect(res.body.error).toBe("Content-Type must be application/json");
    });

    it("should reject missing Content-Type on POST with 415", async () => {
      const res = await request(app)
        .post("/test")
        .set("Content-Type", "") // Explicitly clear Content-Type
        .send("test");

      expect(res.status).toBe(415);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    });

    it("should accept application/json on PUT", async () => {
      const res = await request(app)
        .put("/test")
        .set("Content-Type", "application/json")
        .send({ data: "test" });

      expect(res.status).toBe(200);
    });

    it("should reject non-JSON Content-Type on PUT with 415", async () => {
      const res = await request(app)
        .put("/test")
        .set("Content-Type", "application/xml")
        .send("<test/>");

      expect(res.status).toBe(415);
    });

    it("should accept application/json on PATCH", async () => {
      const res = await request(app)
        .patch("/test")
        .set("Content-Type", "application/json")
        .send({ data: "test" });

      expect(res.status).toBe(200);
    });

    it("should reject non-JSON Content-Type on PATCH with 415", async () => {
      const res = await request(app)
        .patch("/test")
        .set("Content-Type", "text/html")
        .send("<test/>");

      expect(res.status).toBe(415);
    });
  });

  describe("Accept Header Validation", () => {
    it("should accept application/json Accept header", async () => {
      const res = await request(app)
        .post("/test")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .send({ data: "test" });

      expect(res.status).toBe(200);
    });

    it("should accept */* Accept header", async () => {
      const res = await request(app)
        .post("/test")
        .set("Content-Type", "application/json")
        .set("Accept", "*/*")
        .send({ data: "test" });

      expect(res.status).toBe(200);
    });

    it("should accept missing Accept header", async () => {
      const res = await request(app)
        .post("/test")
        .set("Content-Type", "application/json")
        .send({ data: "test" });

      expect(res.status).toBe(200);
    });

    it("should reject invalid Accept header with 406", async () => {
      const res = await request(app)
        .post("/test")
        .set("Content-Type", "application/json")
        .set("Accept", "text/html")
        .send({ data: "test" });

      expect(res.status).toBe(406);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("NOT_ACCEPTABLE");
      expect(res.body.error).toBe("Accept header must include application/json");
    });

    it("should reject complex invalid Accept header with 406", async () => {
      const res = await request(app)
        .post("/test")
        .set("Content-Type", "application/json")
        .set("Accept", "text/html, application/xml;q=0.9")
        .send({ data: "test" });

      expect(res.status).toBe(406);
    });
  });

  describe("Method Skipping", () => {
    it("should skip Content-Type check on GET", async () => {
      const res = await request(app).get("/test");
      expect(res.status).toBe(200);
    });

    it("should skip Content-Type check on DELETE", async () => {
      const res = await request(app).delete("/test");
      expect(res.status).toBe(200);
    });

    it("should skip OPTIONS (CORS preflight)", async () => {
      const res = await request(app).options("/test");
      expect(res.status).toBe(200);
    });

    it("should skip Accept check on GET", async () => {
      const res = await request(app)
        .get("/test")
        .set("Accept", "text/html");

      expect(res.status).toBe(200);
    });
  });

  describe("Path Exclusion", () => {
    let excludedApp: Express;

    beforeEach(() => {
      excludedApp = express();
      excludedApp.use(express.json());
      excludedApp.use(
        createContentNegotiationMiddleware({
          excludePaths: ["/webhooks", "/api/v1/webhook"],
        }),
      );
      excludedApp.post("/webhooks/test", (req, res) => {
        res.json({ success: true });
      });
      excludedApp.post("/api/v1/webhook", (req, res) => {
        res.json({ success: true });
      });
      excludedApp.post("/api/v1/other", (req, res) => {
        res.json({ success: true });
      });
    });

    it("should skip checks for excluded path exact match", async () => {
      const res = await request(excludedApp)
        .post("/webhooks/test")
        .set("Content-Type", "text/plain")
        .send("raw data");

      expect(res.status).toBe(200);
    });

    it("should skip checks for excluded path prefix match", async () => {
      const res = await request(excludedApp)
        .post("/api/v1/webhook")
        .set("Content-Type", "text/plain")
        .send("raw data");

      expect(res.status).toBe(200);
    });

    it("should enforce checks for non-excluded paths", async () => {
      const res = await request(excludedApp)
        .post("/api/v1/other")
        .set("Content-Type", "text/plain")
        .send("raw data");

      expect(res.status).toBe(415);
    });
  });
});

describe("Content Negotiation - Integration with createApp()", () => {
  describe("With content negotiation enabled (default)", () => {
    let app: ReturnType<typeof createApp>;

    beforeEach(() => {
      app = createApp({
        enableContentNegotiation: true,
      });
    });

    it("should reject POST with wrong Content-Type", async () => {
      const res = await request(app)
        .post("/api/v1/slots")
        .set("Content-Type", "text/plain")
        .send("test");

      expect(res.status).toBe(415);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    });

    it("should accept POST with valid Content-Type", async () => {
      const res = await request(app)
        .post("/api/v1/slots")
        .set("Content-Type", "application/json")
        .send({
          professional: "test-pro",
          startTime: Date.now(),
          endTime: Date.now() + 3600000,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it("should reject POST with invalid Accept header", async () => {
      const res = await request(app)
        .post("/api/v1/slots")
        .set("Content-Type", "application/json")
        .set("Accept", "text/html")
        .send({
          professional: "test-pro",
          startTime: Date.now(),
          endTime: Date.now() + 3600000,
        });

      expect(res.status).toBe(406);
      expect(res.body.code).toBe("NOT_ACCEPTABLE");
    });

    it("should set Content-Type response header", async () => {
      const res = await request(app).get("/api/v1/slots");

      expect(res.get("Content-Type")).toContain("application/json");
    });

    it("should allow GET without Content-Type", async () => {
      const res = await request(app).get("/api/v1/slots");

      expect(res.status).toBe(200);
    });
  });

  describe("With content negotiation disabled", () => {
    let app: ReturnType<typeof createApp>;

    beforeEach(() => {
      app = createApp({
        enableContentNegotiation: false,
      });
    });

    it("should accept POST with any Content-Type when disabled", async () => {
      const res = await request(app)
        .post("/api/v1/slots")
        .set("Content-Type", "text/plain")
        .send("test");

      // Will fail validation, not content negotiation
      expect(res.status).not.toBe(415);
    });
  });

  describe("With excluded paths", () => {
    let testApp: Express;

    beforeEach(() => {
      testApp = express();
      testApp.use(express.json());
      testApp.use(
        createContentNegotiationMiddleware({
          excludePaths: ["/api/v1/webhooks"],
        }),
      );
      testApp.post("/api/v1/webhooks/test", (req, res) => {
        res.json({ success: true });
      });

      // Register error handler
      testApp.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
        if (err && err.statusCode && (err.statusCode === 415 || err.statusCode === 406)) {
          return res.status(err.statusCode).json({
            success: false,
            code: err.code,
            error: err.message,
          });
        }
        return res.status(500).json({ success: false, error: "Internal server error" });
      });
    });

    it("should skip checks for excluded paths", async () => {
      const res = await request(testApp)
        .post("/api/v1/webhooks/test")
        .set("Content-Type", "application/xml")
        .send("<test/>");

      expect(res.status).toBe(200);
    });
  });
});

describe("Content Negotiation - Error Envelope Format", () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(createContentNegotiationMiddleware());
    app.post("/test", (req, res) => {
      res.json({ success: true });
    });

    // Register error handler
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      if (err && err.statusCode && (err.statusCode === 415 || err.statusCode === 406)) {
        return res.status(err.statusCode).json({
          success: false,
          code: err.code,
          error: err.message,
        });
      }
      return res.status(500).json({ success: false, error: "Internal server error" });
    });
  });

  it("should return proper error envelope for 415", async () => {
    const res = await request(app)
      .post("/test")
      .set("Content-Type", "text/plain")
      .send("test");

    expect(res.body).toEqual({
      success: false,
      code: "UNSUPPORTED_MEDIA_TYPE",
      error: "Content-Type must be application/json",
    });
  });

  it("should return proper error envelope for 406", async () => {
    const res = await request(app)
      .post("/test")
      .set("Content-Type", "application/json")
      .set("Accept", "text/html")
      .send({ data: "test" });

    expect(res.body).toEqual({
      success: false,
      code: "NOT_ACCEPTABLE",
      error: "Accept header must include application/json",
    });
  });

  it("should not leak header values in error messages", async () => {
    const res = await request(app)
      .post("/test")
      .set("Content-Type", "custom/type; secret=value")
      .send("test");

    expect(res.body.error).toBe("Content-Type must be application/json");
    expect(res.body.error).not.toContain("secret");
    expect(res.body.error).not.toContain("custom/type");
  });
});
