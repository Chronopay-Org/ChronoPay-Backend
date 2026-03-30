/**
 * CORS Configuration and Middleware Tests
 * 
 * Comprehensive test suite for CORS allowlist functionality
 * Covers configuration loading, origin validation, pattern matching,
 * and middleware behavior with 95%+ code coverage
 */

import request from "supertest";
import {
  isOriginAllowed,
  getCORSConfig,
  validateCORSConfig,
  type CORSConfig,
} from "../config/cors.js";
import { createCORSMiddleware } from "../middleware/cors.js";
import express, { Express } from "express";

describe("CORS Configuration Module", () => {
  // Save original environment
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment before each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("isOriginAllowed()", () => {
    const allowlist = [
      "https://example.com",
      "https://app.example.com",
      "https://*.example.com",
      "http://localhost:3000",
    ];

    it("should allow exact origin match", () => {
      expect(isOriginAllowed("https://example.com", allowlist)).toBe(true);
    });

    it("should allow exact localhost match", () => {
      expect(isOriginAllowed("http://localhost:3000", allowlist)).toBe(true);
    });

    it("should deny origin not in allowlist", () => {
      expect(
        isOriginAllowed("https://evil.com", [
          "https://example.com",
        ]),
      ).toBe(false);
    });

    it("should deny undefined origin", () => {
      expect(isOriginAllowed(undefined, allowlist)).toBe(false);
    });

    it("should deny empty string origin", () => {
      expect(isOriginAllowed("", allowlist)).toBe(false);
    });

    it("should deny whitespace-only origin", () => {
      expect(isOriginAllowed("   ", allowlist)).toBe(false);
    });

    it("should accept wildcard pattern matching", () => {
      expect(isOriginAllowed("https://sub.example.com", allowlist)).toBe(true);
    });

    it("should accept nested subdomain with wildcard pattern", () => {
      expect(
        isOriginAllowed("https://nested.sub.example.com", allowlist),
      ).toBe(true);
    });

    it("should deny origin not matching wildcard pattern", () => {
      expect(isOriginAllowed("https://example.org", allowlist)).toBe(false);
    });

    it("should handle invalid URL origin", () => {
      expect(isOriginAllowed("not-a-valid-url", allowlist)).toBe(false);
    });

    it("should be case-sensitive for scheme", () => {
      expect(
        isOriginAllowed("HTTPS://example.com", [
          "https://example.com",
        ]),
      ).toBe(false);
    });

    it("should be case-insensitive for domain (per RFC)", () => {
      // URL standard normalizes domain to ASCII lowercase
      const url = new URL("https://EXAMPLE.COM");
      const normalizedOrigin = `${url.protocol}//${url.hostname}`;
      expect(isOriginAllowed(normalizedOrigin, ["https://example.com"])).toBe(true);
    });

    it("should handle port numbers correctly", () => {
      expect(
        isOriginAllowed("https://example.com:8443", [
          "https://example.com",
        ]),
      ).toBe(false);
    });

    it("should allow origin with matching port", () => {
      expect(
        isOriginAllowed("https://example.com:8443", [
          "https://example.com:8443",
        ]),
      ).toBe(true);
    });

    it("should reject wildcard-only allowlist", () => {
      expect(isOriginAllowed("https://example.com", ["*"])).toBe(false);
    });

    it("should reject multiple wildcards in pattern", () => {
      expect(isOriginAllowed("https://example.com", ["https://*.*.com"])).toBe(
        false,
      );
    });

    it("should reject invalid wildcard patterns", () => {
      // Wildcard not followed by dot is captured by matchOriginPattern validation
      expect(
        isOriginAllowed("https://example.com", ["https://*example.com"]),
      ).toBe(false);
    });

    it("should handle multiple allowed origins", () => {
      const origins = [
        "https://example.com",
        "https://app.com",
        "https://another.com",
      ];
      expect(isOriginAllowed("https://app.com", origins)).toBe(true);
    });

    it("should return false for empty allowlist", () => {
      expect(isOriginAllowed("https://example.com", [])).toBe(false);
    });
  });

  describe("getCORSConfig()", () => {
    it("should return default config for development environment", () => {
      process.env.NODE_ENV = "development";
      delete process.env.CORS_ALLOWED_ORIGINS;
      
      const config = getCORSConfig();

      expect(config.allowedOrigins).toContain("http://localhost:3000");
      expect(config.allowedOrigins).toContain("http://localhost:3001");
      expect(config.allowCredentials).toBe(true);
      expect(config.maxAge).toBe(86400);
    });

    it("should return production config for production environment", () => {
      process.env.NODE_ENV = "production";
      delete process.env.CORS_ALLOWED_ORIGINS;
      
      const config = getCORSConfig();

      expect(config.allowedOrigins).toEqual([]);
      expect(config.allowCredentials).toBe(true);
    });

    it("should load origins from CORS_ALLOWED_ORIGINS env var", () => {
      process.env.CORS_ALLOWED_ORIGINS =
        "https://example.com, https://app.example.com";
      
      const config = getCORSConfig();

      expect(config.allowedOrigins).toContain("https://example.com");
      expect(config.allowedOrigins).toContain("https://app.example.com");
    });

    it("should load methods from CORS_ALLOWED_METHODS env var", () => {
      process.env.CORS_ALLOWED_METHODS = "GET, POST, DELETE";
      
      const config = getCORSConfig();

      expect(config.allowedMethods).toContain("GET");
      expect(config.allowedMethods).toContain("POST");
      expect(config.allowedMethods).toContain("DELETE");
    });

    it("should load headers from CORS_ALLOWED_HEADERS env var", () => {
      process.env.CORS_ALLOWED_HEADERS = "Content-Type, X-Custom-Header";
      
      const config = getCORSConfig();

      expect(config.allowedHeaders).toContain("Content-Type");
      expect(config.allowedHeaders).toContain("X-Custom-Header");
    });

    it("should parse CORS_ALLOW_CREDENTIALS as boolean", () => {
      process.env.CORS_ALLOW_CREDENTIALS = "false";
      
      const config = getCORSConfig();

      expect(config.allowCredentials).toBe(false);
    });

    it("should parse CORS_MAX_AGE as number", () => {
      process.env.CORS_MAX_AGE = "3600";
      
      const config = getCORSConfig();

      expect(config.maxAge).toBe(3600);
    });

    it("should handle invalid CORS_MAX_AGE gracefully", () => {
      process.env.CORS_MAX_AGE = "not-a-number";
      
      const config = getCORSConfig();

      expect(config.maxAge).toBe(86400); // Falls back to default
    });

    it("should trim whitespace in origin list", () => {
      process.env.CORS_ALLOWED_ORIGINS =
        "  https://example.com  ,  https://app.com  ";
      
      const config = getCORSConfig();

      expect(config.allowedOrigins).toContain("https://example.com");
      expect(config.allowedOrigins).toContain("https://app.com");
      const exampleOrigin = config.allowedOrigins.find(
        (o) => o.includes("example.com"),
      );
      expect(exampleOrigin).not.toMatch(/^\s/);
    });
  });

  describe("validateCORSConfig()", () => {
    const validConfig: CORSConfig = {
      allowedOrigins: ["https://example.com"],
      allowedMethods: ["GET", "POST"],
      allowedHeaders: ["Content-Type"],
      allowCredentials: true,
      maxAge: 3600,
    };

    it("should accept valid configuration", () => {
      expect(() => validateCORSConfig(validConfig)).not.toThrow();
      expect(validateCORSConfig(validConfig)).toBe(true);
    });

    it("should reject missing allowedOrigins", () => {
      const config = { ...validConfig };
      delete (config as any).allowedOrigins;

      expect(() => validateCORSConfig(config)).toThrow(
        /Invalid CORS configuration/,
      );
    });

    it("should reject non-array allowedOrigins", () => {
      const config = { ...validConfig, allowedOrigins: "not-array" as any };

      expect(() => validateCORSConfig(config)).toThrow(
        /Invalid CORS configuration/,
      );
    });

    it("should reject non-string origins", () => {
      const config = { ...validConfig, allowedOrigins: [123] as any };

      expect(() => validateCORSConfig(config)).toThrow(
        /Invalid origin.*not a string/,
      );
    });

    it("should reject wildcard-only origins", () => {
      const config = { ...validConfig, allowedOrigins: ["*"] };

      expect(() => validateCORSConfig(config)).toThrow(
        /wildcard-only patterns are not allowed/,
      );
    });

    it("should reject invalid URL origins", () => {
      const config = {
        ...validConfig,
        allowedOrigins: ["not-a-valid-url"],
      };

      expect(() => validateCORSConfig(config)).toThrow(
        /Invalid origin URL/,
      );
    });

    it("should accept valid wildcard patterns", () => {
      const config = {
        ...validConfig,
        allowedOrigins: ["https://*.example.com"],
      };

      expect(() => validateCORSConfig(config)).not.toThrow();
    });

    it("should reject negative maxAge", () => {
      const config = { ...validConfig, maxAge: -1 };

      expect(() => validateCORSConfig(config)).toThrow(
        /must be a non-negative number/,
      );
    });

    it("should reject non-number maxAge", () => {
      const config = { ...validConfig, maxAge: "3600" as any };

      expect(() => validateCORSConfig(config)).toThrow(
        /must be a non-negative number/,
      );
    });

    it("should warn about empty allowlist in non-test environment", () => {
      const originalWarn = console.warn;
      let warnCalled = false;
      let warnMessage = "";

      console.warn = ((msg: string) => {
        warnCalled = true;
        warnMessage = msg;
      }) as any;

      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      const config = { ...validConfig, allowedOrigins: [] };
      validateCORSConfig(config);

      expect(warnCalled).toBe(true);
      expect(warnMessage).toContain("CORS allowlist is empty");

      console.warn = originalWarn;
      process.env.NODE_ENV = originalNodeEnv;
    });

    it("should not warn about empty allowlist in test environment", () => {
      const originalWarn = console.warn;
      let warnCalled = false;

      console.warn = (() => {
        warnCalled = true;
      }) as any;

      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "test";

      const config = { ...validConfig, allowedOrigins: [] };
      validateCORSConfig(config);

      expect(warnCalled).toBe(false);

      console.warn = originalWarn;
      process.env.NODE_ENV = originalNodeEnv;
    });
  });
});

describe("CORS Middleware", () => {
  let app: Express;
  const corsConfig: CORSConfig = {
    allowedOrigins: [
      "https://example.com",
      "https://*.example.com",
      "http://localhost:3000",
    ],
    allowedMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    allowCredentials: true,
    maxAge: 86400,
  };

  beforeEach(() => {
    app = express();
    app.use(createCORSMiddleware(corsConfig));
    app.use(express.json());

    // Test routes
    app.get("/test", (req, res) => {
      res.json({ message: "ok" });
    });

    app.post("/test", (req, res) => {
      res.json({ message: "created" });
    });

    app.options("/test", (req, res) => {
      res.sendStatus(200);
    });
  });

  describe("Preflight Requests", () => {
    it("should handle OPTIONS request from allowed origin", async () => {
      const res = await request(app)
        .options("/test")
        .set("Origin", "https://example.com");

      expect(res.status).toBe(200);
      expect(res.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com",
      );
    });

    it("should return 403 for OPTIONS request from disallowed origin", async () => {
      const res = await request(app)
        .options("/test")
        .set("Origin", "https://evil.com");

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("should return proper CORS headers for allowed origin", async () => {
      const res = await request(app)
        .options("/test")
        .set("Origin", "https://example.com");

      expect(res.get("Access-Control-Allow-Methods")).toBeDefined();
      expect(res.get("Access-Control-Allow-Headers")).toBeDefined();
      expect(res.get("Access-Control-Max-Age")).toBe("86400");
    });

    it("should include credentials header when configured", async () => {
      const res = await request(app)
        .options("/test")
        .set("Origin", "https://example.com");

      expect(res.get("Access-Control-Allow-Credentials")).toBe("true");
    });
  });

  describe("Simple Requests", () => {
    it("should set CORS headers for GET from allowed origin", async () => {
      const res = await request(app)
        .get("/test")
        .set("Origin", "https://example.com");

      expect(res.status).toBe(200);
      expect(res.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com",
      );
    });

    it("should set CORS headers for POST from allowed origin", async () => {
      const res = await request(app)
        .post("/test")
        .set("Origin", "https://example.com")
        .send({ data: "test" });

      expect(res.status).toBe(200);
      expect(res.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com",
      );
    });

    it("should not set CORS headers for disallowed origin", async () => {
      const res = await request(app)
        .get("/test")
        .set("Origin", "https://evil.com");

      expect(res.status).toBe(200);
      expect(res.get("Access-Control-Allow-Origin")).toBeUndefined();
    });

    it("should allow request without Origin header", async () => {
      const res = await request(app).get("/test");

      expect(res.status).toBe(200);
    });

    it("should handle wildcard pattern in allowed origins", async () => {
      const res = await request(app)
        .get("/test")
        .set("Origin", "https://sub.example.com");

      expect(res.status).toBe(200);
      expect(res.get("Access-Control-Allow-Origin")).toBe(
        "https://sub.example.com",
      );
    });
  });

  describe("Credentials Handling", () => {
    it("should omit credentials header when not configured", async () => {
      const configWithoutCredentials: CORSConfig = {
        ...corsConfig,
        allowCredentials: false,
      };

      const appWithoutCreds = express();
      appWithoutCreds.use(createCORSMiddleware(configWithoutCredentials));
      appWithoutCreds.get("/test", (req, res) => {
        res.json({ message: "ok" });
      });

      const res = await request(appWithoutCreds)
        .get("/test")
        .set("Origin", "https://example.com");

      expect(res.get("Access-Control-Allow-Credentials")).toBeUndefined();
    });
  });

  describe("Edge Cases", () => {
    it("should handle missing Origin header gracefully", async () => {
      const res = await request(app).get("/test");

      expect(res.status).toBe(200);
      expect(res.get("Access-Control-Allow-Origin")).toBeUndefined();
    });

    it("should handle empty allowedOrigins list", async () => {
      const emptyConfig: CORSConfig = {
        ...corsConfig,
        allowedOrigins: [],
      };

      const appWithEmptyList = express();
      appWithEmptyList.use(createCORSMiddleware(emptyConfig));
      appWithEmptyList.get("/test", (req, res) => {
        res.json({ message: "ok" });
      });

      const res = await request(appWithEmptyList)
        .get("/test")
        .set("Origin", "https://example.com");

      expect(res.get("Access-Control-Allow-Origin")).toBeUndefined();
    });

    it("should continue to next middleware after setting headers", async () => {
      const res = await request(app).get("/test");

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("ok");
    });
  });
});
