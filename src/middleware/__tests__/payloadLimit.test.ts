import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { payloadLimit, ROUTE_PAYLOAD_LIMITS } from "../payloadLimit.js";
import { jsonParseErrorHandler } from "../errorHandling.js";

jest.unstable_mockModule("../rateLimitStore.js", () => ({
  rateLimitRedisStore: {
    async incr() {
      return 1;
    },
    async decrement() {},
    async resetKey() {},
  },
}));

describe("payload limit middleware", () => {
  describe("ROUTE_PAYLOAD_LIMITS registry", () => {
    it("defines checkout limit as 16kb", () => {
      expect(ROUTE_PAYLOAD_LIMITS.checkout).toBe("16kb");
    });

    it("defines slots limit as 32kb", () => {
      expect(ROUTE_PAYLOAD_LIMITS.slots).toBe("32kb");
    });

    it("defines default limit as 100kb", () => {
      expect(ROUTE_PAYLOAD_LIMITS.default).toBe("100kb");
    });
  });

  describe("size string validation", () => {
    it("validates size string format at middleware load time", () => {
      expect(() => payloadLimit("invalid")).toThrow(
        "payloadLimit: invalid size string \"invalid\""
      );
      expect(() => payloadLimit("123")).toThrow(
        "payloadLimit: invalid size string"
      );
      expect(() => payloadLimit("kb")).toThrow(
        "payloadLimit: invalid size string"
      );
    });

    it("accepts valid size string formats", () => {
      expect(() => payloadLimit("16kb")).not.toThrow();
      expect(() => payloadLimit("1mb")).not.toThrow();
      expect(() => payloadLimit("100b")).not.toThrow();
    });
  });

  describe("malformed JSON handling", () => {
    it("returns 400 with standard error envelope for malformed JSON", async () => {
      const app = express();
      app.use(express.json({ limit: "100kb" }));
      app.use(jsonParseErrorHandler);
      app.use(
        (
          err: unknown,
          _req: express.Request,
          res: express.Response,
          _next: express.NextFunction,
        ) => {
          const error = err as {
            statusCode?: number;
            code?: string;
            message?: string;
          };
          res.status(error.statusCode ?? 500).json({
            success: false,
            code: error.code,
            error: error.message,
          });
        },
      );
      app.post("/echo", (req, res) => {
        res.status(200).json({ body: req.body ?? null });
      });

      const res = await request(app)
        .post("/echo")
        .set("Content-Type", "application/json")
        .send("{ invalid json }");

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        code: "MALFORMED_JSON",
        error: "Malformed JSON payload",
      });
    });

    it("returns 400 for truncated JSON", async () => {
      const app = express();
      app.use(express.json({ limit: "100kb" }));
      app.use(jsonParseErrorHandler);
      app.use(
        (
          err: unknown,
          _req: express.Request,
          res: express.Response,
          _next: express.NextFunction,
        ) => {
          const error = err as {
            statusCode?: number;
            code?: string;
            message?: string;
          };
          res.status(error.statusCode ?? 500).json({
            success: false,
            code: error.code,
            error: error.message,
          });
        },
      );
      app.post("/echo", (req, res) => {
        res.status(200).json({ body: req.body ?? null });
      });

      const res = await request(app)
        .post("/echo")
        .set("Content-Type", "application/json")
        .send('{"key": "value"');

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        code: "MALFORMED_JSON",
        error: "Malformed JSON payload",
      });
    });

    it("does not leak stack traces in production", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      const app = express();
      app.use(express.json({ limit: "100kb" }));
      app.use(jsonParseErrorHandler);
      app.use(
        (
          err: unknown,
          _req: express.Request,
          res: express.Response,
          _next: express.NextFunction,
        ) => {
          const error = err as {
            statusCode?: number;
            code?: string;
            message?: string;
          };
          res.status(error.statusCode ?? 500).json({
            success: false,
            code: error.code,
            error: error.message,
          });
        },
      );
      app.post("/echo", (req, res) => {
        res.status(200).json({ body: req.body ?? null });
      });

      const res = await request(app)
        .post("/echo")
        .set("Content-Type", "application/json")
        .send("{ invalid json }");

      expect(res.status).toBe(400);
      expect(res.body).not.toHaveProperty("stack");
      expect(res.body).toMatchObject({
        success: false,
        code: "MALFORMED_JSON",
        error: "Malformed JSON payload",
      });

      process.env.NODE_ENV = originalNodeEnv;
    });
  });

  describe("payload size limits", () => {
    it("rejects payloads exceeding per-route limit with 413", async () => {
      const app = express();
      app.use("/limited", ...payloadLimit("1kb"));
      app.use(
        (
          err: unknown,
          _req: express.Request,
          res: express.Response,
          _next: express.NextFunction,
        ) => {
          const error = err as {
            statusCode?: number;
            code?: string;
            message?: string;
          };
          res.status(error.statusCode ?? 500).json({
            success: false,
            code: error.code,
            error: error.message,
          });
        },
      );
      app.post("/limited", (req, res) => {
        res.status(200).json({ body: req.body ?? null });
      });

      const largePayload = JSON.stringify({
        data: "x".repeat(2_000), // 2kb
      });

      const res = await request(app)
        .post("/limited")
        .set("Content-Type", "application/json")
        .send(largePayload);

      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({
        success: false,
        code: "PAYLOAD_TOO_LARGE",
        error: expect.stringContaining("exceeds the 1kb limit"),
      });
    });

    it("accepts payloads within the per-route limit", async () => {
      const app = express();
      app.use("/limited", ...payloadLimit("1kb"));
      app.use(
        (
          err: unknown,
          _req: express.Request,
          res: express.Response,
          _next: express.NextFunction,
        ) => {
          const error = err as {
            statusCode?: number;
            code?: string;
            message?: string;
          };
          res.status(error.statusCode ?? 500).json({
            success: false,
            code: error.code,
            error: error.message,
          });
        },
      );
      app.post("/limited", (req, res) => {
        res.status(200).json({ body: req.body ?? null });
      });

      const smallPayload = JSON.stringify({
        data: "x".repeat(500), // 500 bytes
      });

      const res = await request(app)
        .post("/limited")
        .set("Content-Type", "application/json")
        .send(smallPayload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ body: { data: "x".repeat(500) } });
    });
  });
});
