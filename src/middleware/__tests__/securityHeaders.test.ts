import request from "supertest";
import { createApp } from "../../app.js";
import { createSecurityHeaders } from "../securityHeaders.js";
import express from "express";

describe("Security Headers Middleware", () => {
  describe("Default Middleware (via integration)", () => {
    const app = createApp();

    it("applies default security headers on success responses", async () => {
      const response = await request(app).get("/health");

      expect(response.status).toBe(200);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(response.headers["permissions-policy"]).toBe("geolocation=(), microphone=(), camera=(), payment=()");
      expect(response.headers["content-security-policy"]).toBeUndefined();
    });

    it("applies default security headers on error responses (404)", async () => {
      const response = await request(app).get("/non-existent-path");

      expect(response.status).toBe(404);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(response.headers["permissions-policy"]).toBe("geolocation=(), microphone=(), camera=(), payment=()");
    });
  });

  describe("createSecurityHeaders Factory", () => {
    it("allows enabling CSP with default directives", async () => {
      const app = express();
      app.use(createSecurityHeaders({ enableCSP: true }));
      app.get("/test", (_req, res) => res.send("ok"));

      const response = await request(app).get("/test");

      expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
      expect(response.headers["content-security-policy"]).toContain("script-src 'self' 'unsafe-inline'");
    });

    it("allows merging custom CSP directives", async () => {
      const app = express();
      app.use(createSecurityHeaders({ 
        enableCSP: true,
        cspDirectives: { "connect-src": "'self' https://api.stellar.org" }
      }));
      app.get("/test", (_req, res) => res.send("ok"));

      const response = await request(app).get("/test");

      expect(response.headers["content-security-policy"]).toContain("connect-src 'self' https://api.stellar.org");
      // Check that other defaults still exist
      expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    });

    it("allows disabling specific headers", async () => {
      const app = express();
      app.use(createSecurityHeaders({ 
        enableFrameOptions: false,
        enableReferrerPolicy: false,
        enablePermissionsPolicy: false
      }));
      app.get("/test", (_req, res) => res.send("ok"));

      const response = await request(app).get("/test");

      expect(response.headers["x-content-type-options"]).toBe("nosniff"); // Cannot be disabled
      expect(response.headers["x-frame-options"]).toBeUndefined();
      expect(response.headers["referrer-policy"]).toBeUndefined();
      expect(response.headers["permissions-policy"]).toBeUndefined();
    });
  });
});
