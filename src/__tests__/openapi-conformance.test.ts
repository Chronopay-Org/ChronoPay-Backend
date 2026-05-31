import { jest } from "@jest/globals";
import swaggerJsdoc from "swagger-jsdoc";
import { createApp } from "../app.js";

// Global stubs to prevent ReferenceError from missing imports in app.ts when imported in test environment
(globalThis as any).createCORSMiddleware = () => (req: any, res: any, next: any) => next();
(globalThis as any).getCORSConfig = () => ({});

// Define allowlists
const PRIVATE_EXEMPT_ROUTES = new Set([
  "GET /health",
  "GET /ready",
  "GET /live",
  "GET /health/ready",
  "GET /metrics",
  "GET /__test__/explode",
  "POST /api/v1/test/auth",
]);

const LEGACY_UNDOCUMENTED_ROUTES = new Set([
  "GET /api/v1/slots",
  "POST /api/v1/slots",
  "DELETE /api/v1/slots/{id}",
  "POST /api/v1/buyer-profiles",
  "GET /api/v1/buyer-profiles/me",
  "GET /api/v1/buyer-profiles",
  "GET /api/v1/buyer-profiles/{id}",
  "PATCH /api/v1/buyer-profiles/{id}",
  "DELETE /api/v1/buyer-profiles/{id}",
  "POST /api/v1/booking-intents",
  "POST /api/v1/webhooks/settlements",
  "POST /api/v1/notifications/sms",
]);

// Convert Express path style (e.g. /:sessionId) to OpenAPI style (e.g. {sessionId})
function expressPathToOpenAPI(expressPath: string): string {
  return expressPath.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
}

// Walk Express router recursively to find all route-method combinations
function walkExpressRoutes(app: any): Array<{ path: string; method: string }> {
  const routes: Array<{ path: string; method: string }> = [];

  function walk(middleware: any, parentPath = "") {
    if (middleware.route) {
      const pathPart = middleware.route.path;
      let fullPath = `${parentPath}${pathPart}`.replace(/\/+/g, "/");
      if (fullPath.endsWith("/") && fullPath.length > 1) {
        fullPath = fullPath.slice(0, -1);
      }
      const methods = Object.keys(middleware.route.methods);
      for (const method of methods) {
        routes.push({
          path: fullPath,
          method: method.toLowerCase(),
        });
      }
    } else if (middleware.name === "router" && middleware.handle.stack) {
      const regexpSource = middleware.regexp.source;
      const match = regexpSource
        .replace(/^\^/, "")
        .replace(/\\\//g, "/")
        .split("(?=")[0]
        .replace(/\/\?$/, "")
        .replace(/\/\$$/, "");
      
      let routePrefix = match;
      if (!routePrefix.startsWith("/")) {
        routePrefix = "/" + routePrefix;
      }

      for (const handler of middleware.handle.stack) {
        walk(handler, parentPath + routePrefix);
      }
    } else if (middleware.stack) {
      for (const handler of middleware.stack) {
        walk(handler, parentPath);
      }
    }
  }

  if (app._router && app._router.stack) {
    for (const middleware of app._router.stack) {
      walk(middleware);
    }
  }

  return routes;
}

describe("OpenAPI Route Conformance", () => {
  let app: any;
  let swaggerSpec: any;
  let expressRoutes: Array<{ path: string; method: string }> = [];
  let documentedRoutes: Array<{ path: string; method: string }> = [];

  beforeAll(() => {
    // Instantiate Express app
    app = createApp({ enableDocs: false, enableTestRoutes: true });

    // Generate Swagger Spec with exact same options as app.ts
    const options = {
      swaggerDefinition: {
        openapi: "3.0.0",
        info: {
          title: "ChronoPay API",
          version: "1.0.0",
          description: "API for ChronoPay payment and scheduling platform",
        },
      },
      apis: ["./src/routes/*.ts", "./src/index.ts"],
    };
    swaggerSpec = swaggerJsdoc(options);

    // Extract all Express routes
    expressRoutes = walkExpressRoutes(app);

    // Extract all documented routes from spec
    if (swaggerSpec && swaggerSpec.paths) {
      for (const pathKey of Object.keys(swaggerSpec.paths)) {
        const pathItem = swaggerSpec.paths[pathKey];
        for (const methodKey of Object.keys(pathItem)) {
          if (["get", "post", "put", "delete", "patch"].includes(methodKey.toLowerCase())) {
            documentedRoutes.push({
              path: pathKey,
              method: methodKey.toLowerCase(),
            });
          }
        }
      }
    }
  });

  it("asserts every public Express route is documented in the OpenAPI spec", () => {
    const missingDocs: string[] = [];

    for (const route of expressRoutes) {
      const openApiPath = expressPathToOpenAPI(route.path);
      const routeIdentifier = `${route.method.toUpperCase()} ${openApiPath}`;

      // Skip private or legacy undocumented routes
      if (PRIVATE_EXEMPT_ROUTES.has(routeIdentifier) || LEGACY_UNDOCUMENTED_ROUTES.has(routeIdentifier)) {
        continue;
      }

      // Check if documented
      const isDocumented = documentedRoutes.some(
        (doc) => doc.path === openApiPath && doc.method === route.method
      );

      if (!isDocumented) {
        missingDocs.push(routeIdentifier);
      }
    }

    if (missingDocs.length > 0) {
      const message = [
        "❌ OpenAPI Conformance Failure: Undocumented Express routes found!",
        "Every public route must be documented using JSDoc @openapi annotations.",
        "",
        "Undocumented routes:",
        ...missingDocs.map((r) => `  - ${r}`),
        "",
        "If these are intentional system/private endpoints, add them to the PRIVATE_EXEMPT_ROUTES allowlist in openapi-conformance.test.ts.",
      ].join("\n");

      throw new Error(message);
    }
  });

  it("asserts every documented OpenAPI route actually exists in the Express application", () => {
    const ghostDocs: string[] = [];

    for (const doc of documentedRoutes) {
      const routeIdentifier = `${doc.method.toUpperCase()} ${doc.path}`;

      // Check if route exists in Express router stack
      const existsInExpress = expressRoutes.some(
        (route) => expressPathToOpenAPI(route.path) === doc.path && route.method === doc.method
      );

      if (!existsInExpress) {
        ghostDocs.push(routeIdentifier);
      }
    }

    if (ghostDocs.length > 0) {
      const message = [
        "❌ OpenAPI Conformance Failure: Documented OpenAPI routes do not exist in the Express application!",
        "",
        "Ghost routes in specification:",
        ...ghostDocs.map((r) => `  - ${r}`),
        "",
        "Please remove these obsolete entries from your JSDoc @openapi annotations.",
      ].join("\n");

      throw new Error(message);
    }
  });
});
