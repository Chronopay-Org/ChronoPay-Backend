import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { Request, Response, NextFunction } from "express";
import fs from "node:fs";
import { 
  requireApiKey, 
  deriveApiKeyId, 
  matchEndpoint, 
  isEndpointAllowed
} from "../apiKeyAuth.js";
import { ERROR_CODES } from "../../errors/errorCodes.js";
import { defaultAuditLogger } from "../../services/auditLogger.js";
import { partnerTierService } from "../../services/partnerTierService.js";

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
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
    jest.clearAllMocks();
    
    jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      tiers: {
        basic: ["GET /api/v1/public/*"],
        premium: ["*"]
      }
    }));
    
    jest.spyOn(defaultAuditLogger, 'log').mockResolvedValue(undefined as any);
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
      expect(isEndpointAllowed("basic", "POST", "/api/v1/transactions", config)).toBe(false);
    });

    it("allows premium tier to access anything", () => {
      expect(isEndpointAllowed("premium", "POST", "/api/v1/private", config)).toBe(true);
    });

    it("denies unlisted tier", () => {
      expect(isEndpointAllowed("unlisted", "GET", "/api/v1/public/test", config)).toBe(false);
    });
  });

  describe("requireApiKey", () => {
    it("skips auth if expectedApiKey is not provided", async () => {
      const middleware = requireApiKey();
      await middleware(req as Request, res as Response, next);
      expect(next).toHaveBeenCalledWith();
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
      req.originalUrl = "/api/v1/transactions";

      jest.spyOn(partnerTierService, "fetchPartnerTier").mockResolvedValue("basic");

      await middleware(req as Request, res as Response, next);
      
      expect(res.status).toHaveBeenCalledWith(403);
      expect(defaultAuditLogger.log).toHaveBeenCalledWith(expect.objectContaining({
        action: "PARTNER_TIER_DENIED",
        status: 403,
        metadata: expect.objectContaining({ tier: "basic", method: "POST" })
      }));
    });

    it("handles tier upgrade mid-request by dynamically fetching tier", async () => {
      const middleware = requireApiKey("expected-key");
      (req.header as any).mockReturnValue("expected-key");
      
      req.method = "POST";
      req.originalUrl = "/api/v1/transactions";

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
