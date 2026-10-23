// @ts-nocheck
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import * as crypto from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import fs from "node:fs";
import { 
  requireApiKey, 
  matchEndpoint, 
  isEndpointAllowed,
  deriveApiKeyId
} from "../apiKeyAuth.js";
import { ERROR_CODES } from "../../errors/errorCodes.js";
import { defaultAuditLogger } from "../../services/auditLogger.js";
import { partnerTierService, reloadPartnerTierMap } from "../../services/partnerTierService.js";

describe("apiKeyAuth Middleware", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    req = {
      header: jest.fn(),
      ip: "127.0.0.1",
      method: "GET",
      originalUrl: "/api/v1/public/test",
      baseUrl: "",
      path: "/api/v1/public/test",
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
    jest.clearAllMocks();
    reloadPartnerTierMap("{}");
    
    jest.spyOn(defaultAuditLogger, 'log').mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    reloadPartnerTierMap();
  });

  describe("matchEndpoint", () => {
    it("should match wildcard *", () => {
      expect(matchEndpoint("*", "GET", "/api/v1/anything")).toBe(true);
    });

    it("should match exact endpoint", () => {
      expect(matchEndpoint("POST /api/v1/transactions", "POST", "/api/v1/transactions")).toBe(true);
      expect(matchEndpoint("POST /api/v1/transactions", "GET", "/api/v1/transactions")).toBe(false);
    });

    it("should match path wildcard", () => {
      expect(matchEndpoint("GET /api/v1/public/*", "GET", "/api/v1/public/anything")).toBe(true);
      expect(matchEndpoint("GET /api/v1/public/*", "GET", "/api/v1/public")).toBe(true);
      expect(matchEndpoint("GET /api/v1/public/*", "GET", "/api/v1/private")).toBe(false);
    });
  });

  describe("isEndpointAllowed", () => {
    const config = {
      tiers: {
        basic: ["GET /api/v1/public/*"],
        premium: ["*"]
      }
    };

    it("allows basic tier to access public endpoints", () => {
      expect(isEndpointAllowed("basic", "GET", "/api/v1/public/test", config)).toBe(true);
    });

    it("denies basic tier from private endpoints", () => {
      expect(isEndpointAllowed("basic", "POST", "/api/v1/slots", config)).toBe(false);
    });

    it("allows premium tier to access anything", () => {
      expect(isEndpointAllowed("premium", "POST", "/api/v1/private", config)).toBe(true);
    });

    it("denies unlisted tier", () => {
      expect(isEndpointAllowed("unlisted", "GET", "/api/v1/public/test", config)).toBe(false);
    });
  });

  describe("requireApiKey", () => {
    it("keeps the explicit opt-out in test mode when expectedApiKey is not provided", async () => {
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "test";
      const middleware = requireApiKey();
      await middleware(req as Request, res as Response, next);
      expect(next).toHaveBeenCalledWith();
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    });

    it("returns 503 on a protected route when the key is not configured in production", async () => {
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      const app = express();
      app.get("/protected", requireApiKey(), (_req, response) => response.sendStatus(200));

      await request(app).get("/protected").expect(503);

      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    });

    it("uses crypto.timingSafeEqual when checking an API key", async () => {
      (req.header as any).mockReturnValue("expected-key");
      jest.spyOn(partnerTierService, "fetchPartnerTier").mockResolvedValue("premium");
      const timingSafeEqualSpy = jest.spyOn(crypto, "timingSafeEqual");

      await requireApiKey("expected-key")(req as Request, res as Response, next);

      expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
      timingSafeEqualSpy.mockRestore();
    });

    it("fails if API key is missing", async () => {
      const middleware = requireApiKey("expected-key");
      (req.header as any).mockReturnValue(undefined);
      
      await middleware(req as Request, res as Response, next);
      
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        code: ERROR_CODES.INVALID_API_KEY.code
      }));
    });

    it("fails if API key is invalid", async () => {
      const middleware = requireApiKey("expected-key");
      (req.header as any).mockReturnValue("wrong-key");
      
      await middleware(req as Request, res as Response, next);
      
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it("validates API key and enforces tier allowlist (basic)", async () => {
      const middleware = requireApiKey("expected-key");
      (req.header as any).mockReturnValue("expected-key");
      
      req.method = "POST";
      req.baseUrl = "/api/v1/slots";
      req.path = "/";
      req.originalUrl = "/api/v1/slots";

      await middleware(req as Request, res as Response, next);
      
      expect(res.status).toHaveBeenCalledWith(403);
      expect(req.partnerTier).toBe("basic");
      expect(defaultAuditLogger.log).toHaveBeenCalledWith(expect.objectContaining({
        action: "PARTNER_TIER_DENIED",
        status: 403,
        metadata: expect.objectContaining({ tier: "basic", method: "POST" })
      }));
    });

    it("allows a key explicitly mapped to premium to POST /api/v1/slots", async () => {
      reloadPartnerTierMap(JSON.stringify({
        [deriveApiKeyId("expected-key")]: "premium",
      }));
      const middleware = requireApiKey("expected-key");
      (req.header as any).mockReturnValue("expected-key");
      req.method = "POST";
      req.baseUrl = "/api/v1/slots";
      req.path = "/";
      req.originalUrl = "/api/v1/slots";

      await middleware(req as Request, res as Response, next);

      expect(req.partnerTier).toBe("premium");
      expect(next).toHaveBeenCalledWith();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("allows basic public endpoints with a query string without reading config per request", async () => {
      const readFileSync = jest.spyOn(fs, "readFileSync");
      const middleware = requireApiKey("expected-key");
      (req.header as any).mockReturnValue("expected-key");
      req.method = "GET";
      req.baseUrl = "/api/v1";
      req.path = "/public/test";
      req.originalUrl = "/api/v1/public/test?y=1";

      await middleware(req as Request, res as Response, next);

      expect(req.partnerTier).toBe("basic");
      expect(next).toHaveBeenCalledWith();
      expect(readFileSync).not.toHaveBeenCalled();
    });

    it("handles tier upgrade mid-request by dynamically fetching tier", async () => {
      const middleware = requireApiKey("expected-key");
      (req.header as any).mockReturnValue("expected-key");
      
      req.method = "POST";
      req.baseUrl = "/api/v1/slots";
      req.path = "/";
      req.originalUrl = "/api/v1/slots";

      let calls = 0;
      jest.spyOn(partnerTierService, "fetchPartnerTier").mockImplementation(async () => {
        calls++;
        return calls === 1 ? "basic" : "premium";
      });

      await middleware(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();

      jest.clearAllMocks();
      res.status = jest.fn().mockReturnThis();

      await middleware(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});
