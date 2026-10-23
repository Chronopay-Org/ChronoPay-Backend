import request from "supertest";
import { createSecurityHeaders, securityHeaders, SecurityHeadersOptions } from "../securityHeaders.js";
import express, { Request, Response } from "express";
import { jest } from "@jest/globals";

describe("Security Headers Middleware", () => {
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

  describe("SecurityHeadersOptions Interface", () => {
    describe("with default options (empty object)", () => {
      it("creates middleware with all defaults", async () => {
        const app = express();
        app.use(createSecurityHeaders({}));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");

        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        expect(response.headers["x-frame-options"]).toBe("DENY");
        expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
        expect(response.headers["permissions-policy"]).toBe("geolocation=(), microphone=(), camera=(), payment=()");
        expect(response.headers["content-security-policy"]).toBeUndefined();
      });
    });

    describe("with no options (undefined)", () => {
      it("creates middleware with all defaults", async () => {
        const app = express();
        app.use(createSecurityHeaders());
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");

        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        expect(response.headers["x-frame-options"]).toBe("DENY");
        expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
        expect(response.headers["permissions-policy"]).toBe("geolocation=(), microphone=(), camera=(), payment=()");
        expect(response.headers["content-security-policy"]).toBeUndefined();
      });
    });

    describe("enableCSP option", () => {
      it("enables CSP when set to true", async () => {
        const app = express();
        app.use(createSecurityHeaders({ enableCSP: true }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");

        expect(response.headers["content-security-policy"]).toBeDefined();
        expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
      });

      it("disables CSP when set to false (explicit)", async () => {
        const app = express();
        app.use(createSecurityHeaders({ enableCSP: false }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");

        expect(response.headers["content-security-policy"]).toBeUndefined();
      });

      it("includes all default CSP directives when enabled", async () => {
        const app = express();
        app.use(createSecurityHeaders({ enableCSP: true }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");
        const csp = response.headers["content-security-policy"];

        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("script-src 'self' 'unsafe-inline'");
        expect(csp).toContain("style-src 'self' 'unsafe-inline'");
        expect(csp).toContain("img-src 'self' data: https:");
        expect(csp).toContain("font-src 'self' data:");
        expect(csp).toContain("connect-src 'self'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("base-uri 'self'");
        expect(csp).toContain("form-action 'self'");
      });
    });

    describe("cspDirectives option", () => {
      it("merges custom directives with defaults", async () => {
        const app = express();
        const customDirectives = {
          "connect-src": "'self' https://api.example.com",
          "img-src": "'self' https://images.example.com"
        };
        app.use(createSecurityHeaders({ enableCSP: true, cspDirectives: customDirectives }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");
        const csp = response.headers["content-security-policy"];

        expect(csp).toContain("connect-src 'self' https://api.example.com");
        expect(csp).toContain("img-src 'self' https://images.example.com");
        expect(csp).toContain("default-src 'self'"); // Other defaults preserved
      });

      it("overrides default directives with custom ones", async () => {
        const app = express();
        app.use(createSecurityHeaders({ 
          enableCSP: true, 
          cspDirectives: { "default-src": "'none'" }
        }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");
        const csp = response.headers["content-security-policy"];

        expect(csp).toContain("default-src 'none'");
        expect(csp).not.toContain("default-src 'self'");
      });

      it("adds completely new directives", async () => {
        const app = express();
        app.use(createSecurityHeaders({ 
          enableCSP: true, 
          cspDirectives: { "media-src": "'self' https://videos.example.com" }
        }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");
        const csp = response.headers["content-security-policy"];

        expect(csp).toContain("media-src 'self' https://videos.example.com");
      });

      it("handles empty cspDirectives object", async () => {
        const app = express();
        app.use(createSecurityHeaders({ enableCSP: true, cspDirectives: {} }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");
        const csp = response.headers["content-security-policy"];

        expect(csp).toContain("default-src 'self'");
      });
    });

    describe("enableFrameOptions option", () => {
      it("sets X-Frame-Options when enabled (default)", async () => {
        const app = express();
        app.use(createSecurityHeaders({ enableFrameOptions: true }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");

        expect(response.headers["x-frame-options"]).toBe("DENY");
      });

      it("omits X-Frame-Options when disabled", async () => {
        const app = express();
        app.use(createSecurityHeaders({ enableFrameOptions: false }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");

        expect(response.headers["x-frame-options"]).toBeUndefined();
      });
    });

    describe("enableReferrerPolicy option", () => {
      it("sets Referrer-Policy when enabled (default)", async () => {
        const app = express();
        app.use(createSecurityHeaders({ enableReferrerPolicy: true }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");

        expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      });

      it("omits Referrer-Policy when disabled", async () => {
        const app = express();
        app.use(createSecurityHeaders({ enableReferrerPolicy: false }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");

        expect(response.headers["referrer-policy"]).toBeUndefined();
      });
    });

    describe("enablePermissionsPolicy option", () => {
      it("sets Permissions-Policy when enabled (default)", async () => {
        const app = express();
        app.use(createSecurityHeaders({ enablePermissionsPolicy: true }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");

        expect(response.headers["permissions-policy"]).toBe("geolocation=(), microphone=(), camera=(), payment=()");
      });

      it("omits Permissions-Policy when disabled", async () => {
        const app = express();
        app.use(createSecurityHeaders({ enablePermissionsPolicy: false }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");

        expect(response.headers["permissions-policy"]).toBeUndefined();
      });
    });

    describe("option combinations", () => {
      it("allows enabling all options", async () => {
        const app = express();
        app.use(createSecurityHeaders({
          enableCSP: true,
          enableFrameOptions: true,
          enableReferrerPolicy: true,
          enablePermissionsPolicy: true,
          cspDirectives: { "connect-src": "'self' https://api.example.com" }
        }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");

        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        expect(response.headers["x-frame-options"]).toBe("DENY");
        expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
        expect(response.headers["permissions-policy"]).toBe("geolocation=(), microphone=(), camera=(), payment=()");
        expect(response.headers["content-security-policy"]).toContain("connect-src 'self' https://api.example.com");
      });

      it("allows disabling all optional headers", async () => {
        const app = express();
        app.use(createSecurityHeaders({
          enableCSP: false,
          enableFrameOptions: false,
          enableReferrerPolicy: false,
          enablePermissionsPolicy: false
        }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");

        expect(response.headers["x-content-type-options"]).toBe("nosniff"); // Always set
        expect(response.headers["x-frame-options"]).toBeUndefined();
        expect(response.headers["referrer-policy"]).toBeUndefined();
        expect(response.headers["permissions-policy"]).toBeUndefined();
        expect(response.headers["content-security-policy"]).toBeUndefined();
      });
    });
  });

  describe("securityHeaders (default export)", () => {
    it("is a pre-configured middleware function", async () => {
      const app = express();
      app.use(securityHeaders);
      app.get("/test", (_req, res) => res.send("ok"));

      const response = await request(app).get("/test");

      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(response.headers["permissions-policy"]).toBe("geolocation=(), microphone=(), camera=(), payment=()");
      expect(response.headers["content-security-policy"]).toBeUndefined(); // Disabled by default
    });

    it("matches the default configuration", async () => {
      const app1 = express();
      app1.use(securityHeaders);
      app1.get("/test", (_req, res) => res.send("ok"));

      const app2 = express();
      app2.use(createSecurityHeaders({
        enableCSP: false,
        enableFrameOptions: true,
        enableReferrerPolicy: true,
        enablePermissionsPolicy: true
      }));
      app2.get("/test", (_req, res) => res.send("ok"));

      const response1 = await request(app1).get("/test");
      const response2 = await request(app2).get("/test");

      expect(response1.headers["x-content-type-options"]).toBe(response2.headers["x-content-type-options"]);
      expect(response1.headers["x-frame-options"]).toBe(response2.headers["x-frame-options"]);
      expect(response1.headers["referrer-policy"]).toBe(response2.headers["referrer-policy"]);
      expect(response1.headers["permissions-policy"]).toBe(response2.headers["permissions-policy"]);
      expect(response1.headers["content-security-policy"]).toBe(response2.headers["content-security-policy"]);
    });
  });

  describe("Middleware behavior", () => {
    describe("calls next() properly", () => {
      it("calls next() after setting headers", async () => {
        const nextSpy = jest.fn();
        const middleware = createSecurityHeaders();
        
        const mockReq = {} as Request;
        const mockRes = {
          setHeader: jest.fn()
        } as unknown as Response;

        middleware(mockReq, mockRes, nextSpy);

        expect(nextSpy).toHaveBeenCalledTimes(1);
        expect(nextSpy).toHaveBeenCalledWith();
      });

      it("allows subsequent middleware to execute", async () => {
        const app = express();
        let middlewareExecuted = false;
        
        app.use(createSecurityHeaders());
        app.use((_req, _res, next) => {
          middlewareExecuted = true;
          next();
        });
        app.get("/test", (_req, res) => res.send("ok"));

        await request(app).get("/test");

        expect(middlewareExecuted).toBe(true);
      });
    });

    describe("header persistence", () => {
      it("headers persist through request lifecycle", async () => {
        const app = express();
        app.use(createSecurityHeaders({ enableCSP: true }));
        app.use((_req, _res, next) => {
          // Simulating additional middleware
          next();
        });
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");

        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        expect(response.headers["content-security-policy"]).toBeDefined();
      });

      it("headers are present on different response types", async () => {
        const app = express();
        app.use(createSecurityHeaders());
        app.get("/json", (_req, res) => res.json({ status: "ok" }));
        app.get("/text", (_req, res) => res.send("ok"));
        app.get("/redirect", (_req, res) => res.redirect("/json"));

        const jsonResponse = await request(app).get("/json");
        const textResponse = await request(app).get("/text");
        const redirectResponse = await request(app).get("/redirect").redirects(0);

        expect(jsonResponse.headers["x-content-type-options"]).toBe("nosniff");
        expect(textResponse.headers["x-content-type-options"]).toBe("nosniff");
        expect(redirectResponse.headers["x-content-type-options"]).toBe("nosniff");
      });
    });

    describe("error handling", () => {
      it("applies headers even when route throws error", async () => {
        const app = express();
        app.use(createSecurityHeaders());
        app.get("/error", (_req, _res) => {
          throw new Error("Test error");
        });
        // Error handler
        app.use((err: Error, _req: Request, res: Response, _next: any) => {
          res.status(500).json({ error: err.message });
        });

        const response = await request(app).get("/error");

        expect(response.status).toBe(500);
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        expect(response.headers["x-frame-options"]).toBe("DENY");
      });

      it("applies headers on validation errors", async () => {
        const app = express();
        app.use(createSecurityHeaders());
        app.get("/validate", (_req, res) => {
          res.status(400).json({ error: "Invalid input" });
        });

        const response = await request(app).get("/validate");

        expect(response.status).toBe(400);
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
      });
    });
  });

  describe("Edge cases and boundary conditions", () => {
    describe("invalid or unusual CSP directive values", () => {
      it("handles empty string directive values", async () => {
        const app = express();
        app.use(createSecurityHeaders({ 
          enableCSP: true, 
          cspDirectives: { "default-src": "" }
        }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");

        // Should still generate CSP header, just with empty value for that directive
        expect(response.headers["content-security-policy"]).toBeDefined();
        expect(response.headers["content-security-policy"]).toContain("default-src ");
      });

      it("handles special characters in directive values", async () => {
        const app = express();
        app.use(createSecurityHeaders({ 
          enableCSP: true, 
          cspDirectives: { 
            "script-src": "'self' 'nonce-ABC123' 'sha256-xyz==' https://cdn.example.com" 
          }
        }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");

        expect(response.headers["content-security-policy"]).toContain("script-src 'self' 'nonce-ABC123' 'sha256-xyz==' https://cdn.example.com");
      });

      it("handles multiple custom directives", async () => {
        const app = express();
        app.use(createSecurityHeaders({ 
          enableCSP: true, 
          cspDirectives: {
            "default-src": "'none'",
            "script-src": "'self'",
            "style-src": "'self'",
            "img-src": "'self' data:",
            "font-src": "'self'",
            "connect-src": "'self' https://api.example.com",
            "media-src": "https://videos.example.com",
            "object-src": "'none'",
            "child-src": "'none'",
            "worker-src": "'self'"
          }
        }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");
        const csp = response.headers["content-security-policy"];

        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("worker-src 'self'");
        expect(csp).toContain("media-src https://videos.example.com");
      });
    });

    describe("middleware execution order", () => {
      it("sets headers before route handler executes", async () => {
        let middlewareExecuted = false;
        let headersPresent = false;
        
        const testApp = express();
        testApp.use(createSecurityHeaders());
        testApp.get("/test", (_req, res) => {
          middlewareExecuted = true;
          // Try to read headers set by middleware
          headersPresent = res.hasHeader("X-Content-Type-Options");
          res.send("ok");
        });

        await request(testApp).get("/test");

        expect(middlewareExecuted).toBe(true);
        expect(headersPresent).toBe(true);
      });

      it("does not interfere with headers set by other middleware", async () => {
        const app = express();
        app.use((_req, res, next) => {
          res.setHeader("X-Custom-Header", "custom-value");
          next();
        });
        app.use(createSecurityHeaders());
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");

        expect(response.headers["x-custom-header"]).toBe("custom-value");
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
      });
    });

    describe("CSP header formatting", () => {
      it("separates directives with semicolons", async () => {
        const app = express();
        app.use(createSecurityHeaders({ enableCSP: true }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");
        const csp = response.headers["content-security-policy"];

        // Should have semicolons between directives
        const directives = csp.split(";").map(d => d.trim()).filter(d => d);
        expect(directives.length).toBeGreaterThan(1);
        directives.forEach(directive => {
          expect(directive).toMatch(/^[\w-]+\s+.+$/);
        });
      });

      it("formats directive name and value correctly", async () => {
        const app = express();
        app.use(createSecurityHeaders({ enableCSP: true }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");
        const csp = response.headers["content-security-policy"];

        expect(csp).toMatch(/default-src\s+'self'/);
        expect(csp).toMatch(/script-src\s+'self'\s+'unsafe-inline'/);
      });
    });

    describe("multiple requests", () => {
      it("applies headers consistently across multiple requests", async () => {
        const app = express();
        app.use(createSecurityHeaders({ enableCSP: true }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response1 = await request(app).get("/test");
        const response2 = await request(app).get("/test");
        const response3 = await request(app).get("/test");

        expect(response1.headers["content-security-policy"]).toBe(response2.headers["content-security-policy"]);
        expect(response2.headers["content-security-policy"]).toBe(response3.headers["content-security-policy"]);
      });

      it("does not leak state between requests", async () => {
        const app = express();
        let requestCount = 0;
        
        app.use(createSecurityHeaders());
        app.get("/test", (_req, res) => {
          requestCount++;
          res.send(`request ${requestCount}`);
        });

        await request(app).get("/test");
        const response = await request(app).get("/test");

        expect(response.text).toBe("request 2");
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
      });
    });

    describe("X-Content-Type-Options (non-configurable)", () => {
      it("always sets X-Content-Type-Options regardless of other options", async () => {
        const app = express();
        app.use(createSecurityHeaders({
          enableFrameOptions: false,
          enableReferrerPolicy: false,
          enablePermissionsPolicy: false,
          enableCSP: false
        }));
        app.get("/test", (_req, res) => res.send("ok"));

        const response = await request(app).get("/test");

        expect(response.headers["x-content-type-options"]).toBe("nosniff");
      });

      it("cannot be disabled through any option combination", async () => {
        const configurations: SecurityHeadersOptions[] = [
          {},
          { enableCSP: true },
          { enableFrameOptions: false },
          { enableReferrerPolicy: false, enablePermissionsPolicy: false },
          { enableCSP: true, cspDirectives: { "default-src": "'none'" } }
        ];

        for (const config of configurations) {
          const app = express();
          app.use(createSecurityHeaders(config));
          app.get("/test", (_req, res) => res.send("ok"));

          const response = await request(app).get("/test");
          expect(response.headers["x-content-type-options"]).toBe("nosniff");
        }
      });
    });
  });
});
