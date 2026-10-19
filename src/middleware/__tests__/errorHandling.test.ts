import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
/**
 * Focused behavior coverage for `src/middleware/errorHandling.ts`.
 *
 * Covers:
 *   - notFoundHandler       — 404 envelope, method/path in message, request-id propagation
 *   - jsonParseErrorHandler — pass-through for non-parse errors, wrapped 400 for entity.parse.failed
 *   - genericErrorHandler   — AppError path, duck-typed statusCode+code path, unknown-error 500 fallback
 *
 * Every assertion is deterministic (mocked clock where a timestamp is involved).
 */

import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

import {
  genericErrorHandler,
  jsonParseErrorHandler,
  notFoundHandler,
} from "../errorHandling.js";
import { AppError, MalformedJsonError } from "../../errors/AppError.js";
import { ERROR_CODES } from "../../errors/errorCodes.js";
import { logger } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fixed clock so `AppError.timestamp` is deterministic. */
const FIXED_TIME = "2026-01-01T00:00:00.000Z";

function freezeTime() {
  jest.useFakeTimers({
    now: new Date(FIXED_TIME),
    doNotFake: ["nextTick", "setImmediate", "setInterval", "clearInterval"],
  });
}

function unfreezeTime() {
  jest.useRealTimers();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("errorHandling middleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    freezeTime();
  });

  afterEach(() => {
    unfreezeTime();
  });

  // =========================================================================
  // notFoundHandler
  // =========================================================================
  describe("notFoundHandler", () => {
    it("responds 404 with the NOT_FOUND envelope for an unmatched route", async () => {
      const app = express();
      app.get("/known", (_req, res) => res.send("ok"));
      app.use(notFoundHandler); // catch-all

      const res = await request(app).get("/does-not-exist");

      expect(res.status).toBe(ERROR_CODES.NOT_FOUND.status);
      expect(res.body).toEqual({
        success: false,
        code: ERROR_CODES.NOT_FOUND.code,
        message: "Route not found: GET /does-not-exist",
        error: "Route not found: GET /does-not-exist",
        timestamp: FIXED_TIME,
      });
    });

    it("includes the HTTP method in the message for non-GET methods", async () => {
      const app = express();
      app.use(notFoundHandler);

      const res = await request(app).post("/orders");

      expect(res.status).toBe(404);
      expect(res.body.message).toBe("Route not found: POST /orders");
      expect(res.body.code).toBe("NOT_FOUND");
    });

    it("omits requestId when the request has none", async () => {
      const app = express();
      app.use(notFoundHandler);

      const res = await request(app).get("/x");

      expect(res.body).not.toHaveProperty("requestId");
    });

    it("propagates req.requestId when present", async () => {
      const app = express();
      app.use((req, _res, next) => {
        (req as Request & { requestId?: string }).requestId = "req-123";
        next();
      });
      app.use(notFoundHandler);

      const res = await request(app).get("/x");

      expect(res.body.requestId).toBe("req-123");
    });

    it("falls back to req.id when req.requestId is absent", async () => {
      const app = express();
      app.use((req, _res, next) => {
        (req as Request & { id?: string }).id = "req-from-id";
        next();
      });
      app.use(notFoundHandler);

      const res = await request(app).get("/x");

      expect(res.body.requestId).toBe("req-from-id");
    });
  });

  // =========================================================================
  // jsonParseErrorHandler
  // =========================================================================
  describe("jsonParseErrorHandler", () => {
    it("calls next(err) for non-parse errors (pass-through contract)", () => {
      const err = new Error("unrelated");
      const next = jest.fn() as unknown as NextFunction;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as unknown as Response;

      jsonParseErrorHandler(err, {} as Request, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith(err);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it("calls next(err) for errors whose `type` is not `entity.parse.failed`", () => {
      const err = Object.assign(new Error("wrong type"), { type: "some.other.error" });
      const next = jest.fn() as unknown as NextFunction;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as unknown as Response;

      jsonParseErrorHandler(err, {} as Request, res, next);

      expect(next).toHaveBeenCalledWith(err);
      expect(res.status).not.toHaveBeenCalled();
    });

    it("responds 400 MALFORMED_JSON for entity.parse.failed", () => {
      const err = Object.assign(new SyntaxError("Unexpected token"), {
        type: "entity.parse.failed",
        status: 400,
      });
      const next = jest.fn() as unknown as NextFunction;
      const json = jest.fn();
      const status = jest.fn().mockReturnValue({ json });
      const res = { status } as unknown as Response;
      const req = {} as Request;

      jsonParseErrorHandler(err, req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({
        success: false,
        code: ERROR_CODES.MALFORMED_JSON.code,
        message: "Malformed JSON payload",
        error: "Malformed JSON payload",
        timestamp: FIXED_TIME,
      });
    });

    it("propagates requestId when wrapping a parse error", () => {
      const err = Object.assign(new SyntaxError("bad json"), {
        type: "entity.parse.failed",
      });
      const next = jest.fn() as unknown as NextFunction;
      const json = jest.fn();
      const status = jest.fn().mockReturnValue({ json });
      const res = { status } as unknown as Response;
      const req = { requestId: "req-xyz" } as Request;

      jsonParseErrorHandler(err, req, res, next);

      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "req-xyz", code: "MALFORMED_JSON" }),
      );
    });

    it("matches the wrapping class (MalformedJsonError) status and code", () => {
      const wrapped = new MalformedJsonError();
      expect(wrapped.statusCode).toBe(ERROR_CODES.MALFORMED_JSON.status);
      expect(wrapped.code).toBe(ERROR_CODES.MALFORMED_JSON.code);
    });
  });

  // =========================================================================
  // genericErrorHandler
  // =========================================================================
  describe("genericErrorHandler", () => {
    it("responds with the envelope of an AppError instance", () => {
      const err = new AppError("Boom", 418, "IM_A_TEAPOT", true);
      const next = jest.fn() as unknown as NextFunction;
      const json = jest.fn();
      const status = jest.fn().mockReturnValue({ json });
      const res = { status } as unknown as Response;
      const req = { requestId: "req-abc" } as Request;

      genericErrorHandler(err, req, res, next);

      expect(status).toHaveBeenCalledWith(418);
      expect(json).toHaveBeenCalledWith({
        success: false,
        code: "IM_A_TEAPOT",
        message: "Boom",
        error: "Boom",
        timestamp: FIXED_TIME,
        requestId: "req-abc",
      });
    });

    it("handles duck-typed errors with numeric statusCode and string code", () => {
      // Not an instance of AppError but shaped like one — the handler accepts this by design.
      const duckTyped = Object.assign(new Error("duck"), {
        statusCode: 409,
        code: "CONFLICT",
        toJSON: () => ({
          success: false,
          code: "CONFLICT",
          message: "duck",
          error: "duck",
          timestamp: FIXED_TIME,
        }),
      });
      const next = jest.fn() as unknown as NextFunction;
      const json = jest.fn();
      const status = jest.fn().mockReturnValue({ json });
      const res = { status } as unknown as Response;
      const req = {} as Request;

      genericErrorHandler(duckTyped, req, res, next);

      expect(status).toHaveBeenCalledWith(409);
      expect(json).toHaveBeenCalledWith({
        success: false,
        code: "CONFLICT",
        message: "duck",
        error: "duck",
        timestamp: FIXED_TIME,
      });
    });

    it("falls back to 500 INTERNAL_ERROR for an unknown error shape", () => {
      const err = { something: "unrecognised" };
      const next = jest.fn() as unknown as NextFunction;
      const json = jest.fn();
      const status = jest.fn().mockReturnValue({ json });
      const res = { status } as unknown as Response;
      const req = {} as Request;

      genericErrorHandler(err, req, res, next);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({
        success: false,
        code: ERROR_CODES.INTERNAL_ERROR.code,
        message: "Internal server error",
        error: "Internal server error",
        timestamp: FIXED_TIME,
      });
    });

    it("falls back to 500 INTERNAL_ERROR when statusCode is present but code is not a string", () => {
      const malformed = Object.assign(new Error("odd"), {
        statusCode: 400,
        code: 123 as unknown as string, // invalid type
      });
      const next = jest.fn() as unknown as NextFunction;
      const json = jest.fn();
      const status = jest.fn().mockReturnValue({ json });
      const res = { status } as unknown as Response;
      const req = {} as Request;

      genericErrorHandler(malformed, req, res, next);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({ code: ERROR_CODES.INTERNAL_ERROR.code }),
      );
    });

    it("logs the error via logger.error with requestId context", () => {
      const err = new Error("logged");
      const next = jest.fn() as unknown as NextFunction;
      const json = jest.fn();
      const status = jest.fn().mockReturnValue({ json });
      const res = { status } as unknown as Response;
      const req = { requestId: "req-log" } as Request;
      const spy = jest.spyOn(logger, "error").mockImplementation(() => logger);

      genericErrorHandler(err, req, res, next);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ err, requestId: "req-log" }),
        "unhandled error",
      );
      spy.mockRestore();
    });

    it("propagates req.id as requestId when req.requestId is absent", () => {
      const err = new AppError("Boom", 400, "BAD_REQUEST", true);
      const next = jest.fn() as unknown as NextFunction;
      const json = jest.fn();
      const status = jest.fn().mockReturnValue({ json });
      const res = { status } as unknown as Response;
      const req = { id: "req-from-id" } as Request;

      genericErrorHandler(err, req, res, next);

      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "req-from-id" }),
      );
    });

    it("does not leak 5xx status for a malformed err with only a code string", () => {
      // statusCode missing → falls back to 500.
      const partial = Object.assign(new Error("partial"), { code: "SOMETHING" });
      const next = jest.fn() as unknown as NextFunction;
      const json = jest.fn();
      const status = jest.fn().mockReturnValue({ json });
      const res = { status } as unknown as Response;
      const req = {} as Request;

      genericErrorHandler(partial, req, res, next);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({ code: ERROR_CODES.INTERNAL_ERROR.code }),
      );
    });
  });

  // =========================================================================
  // End-to-end sanity: full errorHandling chain via Express
  // =========================================================================
  describe("integrated chain (express)", () => {
    it("a thrown AppError reaches genericErrorHandler and produces the envelope", async () => {
      const app = express();
      app.get("/boom", () => {
        throw new AppError("Kablammo", 422, "UNPROCESSABLE_ENTITY", true);
      });
      app.use(genericErrorHandler);

      const res = await request(app).get("/boom");

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        success: false,
        code: "UNPROCESSABLE_ENTITY",
        message: "Kablammo",
      });
    });

    it("malformed JSON body is turned into 400 MALFORMED_JSON", async () => {
      const app = express();
      app.use(express.json());
      app.post("/echo", (req, res) => res.json({ body: req.body }));
      // jsonParseErrorHandler must sit right after express.json() and before the routes.
      // Re-mount in the canonical order.
      const withHandler = express();
      withHandler.use(express.json());
      withHandler.use(jsonParseErrorHandler);
      withHandler.post("/echo", (req, res) => res.json({ body: req.body }));

      const res = await request(withHandler)
        .post("/echo")
        .set("Content-Type", "application/json")
        .send('{"broken": '); // invalid JSON

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("MALFORMED_JSON");
      // sanity — the app without the handler is unused here
      expect(app).toBeDefined();
    });
  });
});
