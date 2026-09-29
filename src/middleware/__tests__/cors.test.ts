/**
 * Focused behaviour suite for `createCORSMiddleware` in
 * `src/middleware/cors.ts` (issue #1104).
 *
 * The middleware is the only place CORS response headers are set, so its
 * contract is worth pinning precisely:
 *
 *  - an allowed origin gets the full header set (methods, headers, max-age,
 *    and credentials only when configured);
 *  - a disallowed / missing / malformed origin gets *no* CORS headers, so no
 *    information about the allowlist leaks;
 *  - preflight (`OPTIONS`) requests short-circuit with 200 when allowed and a
 *    deterministic 403 otherwise;
 *  - non-preflight requests always continue the chain via `next()`.
 *
 * Both the unit contract (recording req/res doubles) and an Express integration
 * path are covered. No production code is changed.
 */

import { jest, describe, it, expect } from "@jest/globals";
import express, { NextFunction, Request, Response } from "express";
import request from "supertest";
import { createCORSMiddleware } from "../cors.js";
import type { CORSConfig } from "../../config/cors.js";

const ALLOWED = "https://app.chronopay.test";

function baseConfig(overrides: Partial<CORSConfig> = {}): CORSConfig {
  return {
    allowedOrigins: [ALLOWED],
    allowedMethods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    allowCredentials: true,
    maxAge: 600,
    ...overrides,
  };
}

interface MockRes {
  headers: Record<string, string>;
  statusCode: number;
  body: unknown;
  set: (name: string, value: string) => MockRes;
  status: (code: number) => MockRes;
  json: (payload: unknown) => MockRes;
  sendStatus: (code: number) => MockRes;
}

function makeRes(): MockRes {
  const headers: Record<string, string> = {};
  const res: MockRes = {
    headers,
    statusCode: 200,
    body: undefined,
    set: jest.fn((name: string, value: string) => {
      headers[name] = value;
      return res;
    }),
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((payload: unknown) => {
      res.body = payload;
      return res;
    }),
    sendStatus: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
  };
  return res;
}

function makeReq(origin: string | undefined, method = "GET"): Request {
  return {
    method,
    get: (header: string) => (header.toLowerCase() === "origin" ? origin : undefined),
  } as unknown as Request;
}

function run(middleware: ReturnType<typeof createCORSMiddleware>, req: Request) {
  const res = makeRes();
  const next = jest.fn();
  middleware(req, res as unknown as Response, next as unknown as NextFunction);
  return { res, next };
}

describe("createCORSMiddleware", () => {
  describe("allowed origin (non-preflight)", () => {
    it("sets the full CORS header set and continues the chain", () => {
      const { res, next } = run(createCORSMiddleware(baseConfig()), makeReq(ALLOWED, "GET"));

      expect(res.headers["Access-Control-Allow-Origin"]).toBe(ALLOWED);
      expect(res.headers["Access-Control-Allow-Methods"]).toBe("GET, POST, OPTIONS");
      expect(res.headers["Access-Control-Allow-Headers"]).toBe("Content-Type, Authorization");
      expect(res.headers["Access-Control-Max-Age"]).toBe("600");
      expect(res.headers["Access-Control-Allow-Credentials"]).toBe("true");
      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
    });

    it("echoes the exact origin instead of a wildcard", () => {
      const { res } = run(createCORSMiddleware(baseConfig()), makeReq(ALLOWED, "POST"));

      expect(res.headers["Access-Control-Allow-Origin"]).toBe(ALLOWED);
      expect(res.headers["Access-Control-Allow-Origin"]).not.toBe("*");
    });

    it("omits the credentials header when allowCredentials is false", () => {
      const { res } = run(
        createCORSMiddleware(baseConfig({ allowCredentials: false })),
        makeReq(ALLOWED),
      );

      expect(res.headers["Access-Control-Allow-Credentials"]).toBeUndefined();
    });

    it("allows a wildcard-subdomain pattern from the allowlist", () => {
      const { res } = run(
        createCORSMiddleware(baseConfig({ allowedOrigins: ["https://*.chronopay.test"] })),
        makeReq("https://admin.chronopay.test"),
      );

      expect(res.headers["Access-Control-Allow-Origin"]).toBe("https://admin.chronopay.test");
    });
  });

  describe("disallowed, missing or malformed origin", () => {
    it("sets no CORS headers for a disallowed origin but still calls next()", () => {
      const { res, next } = run(createCORSMiddleware(baseConfig()), makeReq("https://evil.test"));

      expect(Object.keys(res.headers)).toHaveLength(0);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("sets no CORS headers when the Origin header is absent", () => {
      const { res, next } = run(createCORSMiddleware(baseConfig()), makeReq(undefined));

      expect(Object.keys(res.headers)).toHaveLength(0);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("sets no CORS headers for a malformed origin", () => {
      const { res } = run(createCORSMiddleware(baseConfig()), makeReq("not a url"));

      expect(Object.keys(res.headers)).toHaveLength(0);
      expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    });
  });

  describe("preflight (OPTIONS)", () => {
    it("returns 200 and short-circuits (no next()) for an allowed origin", () => {
      const { res, next } = run(
        createCORSMiddleware(baseConfig()),
        makeReq(ALLOWED, "OPTIONS"),
      );

      expect(res.sendStatus).toHaveBeenCalledWith(200);
      expect(res.statusCode).toBe(200);
      expect(next).not.toHaveBeenCalled();
    });

    it("returns a deterministic 403 body for a disallowed origin", () => {
      const { res, next } = run(
        createCORSMiddleware(baseConfig()),
        makeReq("https://evil.test", "OPTIONS"),
      );

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ success: false, error: "CORS policy: Origin not allowed" });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("integration through express", () => {
    it("attaches CORS headers to a real response for an allowed origin", async () => {
      const app = express();
      app.use(createCORSMiddleware(baseConfig()));
      app.get("/health", (_req, res) => res.send("ok"));

      const response = await request(app).get("/health").set("Origin", ALLOWED);

      expect(response.status).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED);
      expect(response.headers["access-control-allow-methods"]).toBe("GET, POST, OPTIONS");
      expect(response.text).toBe("ok");
    });

    it("omits CORS headers for a request from a disallowed origin", async () => {
      const app = express();
      app.use(createCORSMiddleware(baseConfig()));
      app.get("/health", (_req, res) => res.send("ok"));

      const response = await request(app).get("/health").set("Origin", "https://evil.test");

      expect(response.status).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("rejects a preflight from a disallowed origin with 403", async () => {
      const app = express();
      app.use(createCORSMiddleware(baseConfig()));
      app.get("/health", (_req, res) => res.send("ok"));

      const response = await request(app)
        .options("/health")
        .set("Origin", "https://evil.test")
        .set("Access-Control-Request-Method", "GET");

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ success: false, error: "CORS policy: Origin not allowed" });
    });

    it("answers an allowed preflight with 200", async () => {
      const app = express();
      app.use(createCORSMiddleware(baseConfig()));
      app.get("/health", (_req, res) => res.send("ok"));

      const response = await request(app)
        .options("/health")
        .set("Origin", ALLOWED)
        .set("Access-Control-Request-Method", "GET");

      expect(response.status).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED);
    });
  });
});
