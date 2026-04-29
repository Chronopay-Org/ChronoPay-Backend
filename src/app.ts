import { createRequire } from "node:module";
import cors from "cors";
import express, { Request, Response } from "express";
import { requireApiKey } from "./middleware/apiKeyAuth.js";
import { createAuthAwareRateLimiter } from "./middleware/rateLimiter.js";
import { securityHeaders, createSecurityHeaders } from "./middleware/securityHeaders.js";
import {
  genericErrorHandler,
  jsonParseErrorHandler,
  notFoundHandler,
} from "./middleware/errorHandling.js";
import { validateRequiredFields } from "./middleware/validation.js";
import { createContentNegotiationMiddleware } from "./middleware/contentNegotiation.js";
import { createRequestLogger } from "./middleware/requestLogger.js";
import { featureFlagContextMiddleware, initializeFeatureFlagsFromEnv } from "./middleware/featureFlags.js";
import { createBookingIntentsRouter } from "./routes/booking-intents.js";
import { AmountUtils } from "./utils/amount.js";
import checkoutRouter from "./routes/checkout.js";
import { createContentNegotiationMiddleware } from "./middleware/contentNegotiation.js";
import { createRequestLogger } from "./middleware/requestLogger.js";

export interface AppFactoryOptions {
  apiKey?: string;
  enableDocs?: boolean;
  enableTestRoutes?: boolean;
  enableContentNegotiation?: boolean;
  contentNegotiationExcludePaths?: string[];
  slotRepository?: SlotRepository;
  bookingIntentService?: BookingIntentService;
}

function registerSwaggerDocs(app: express.Express) {
  const require = createRequire(import.meta.url);

  try {
    const swaggerUi = require("swagger-ui-express");
    const swaggerJsdoc = require("swagger-jsdoc");

    const options = {
      swaggerDefinition: {
        openapi: "3.0.0",
        info: { 
          title: "ChronoPay API", 
          version: "1.0.0",
          description: "API for ChronoPay payment and scheduling platform"
        },
        components: {
          securitySchemes: {
            // JWT Bearer token authentication
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "JWT",
              description: "JWT token for user authentication (obtained from auth service)"
            },
            // Header-based authentication (current implementation)
            chronoPayAuth: {
              type: "apiKey",
              in: "header",
              name: "x-chronopay-user-id",
              description: "User ID header for authentication (must be paired with x-chronopay-role)"
            },
            // API Key authentication
            apiKeyAuth: {
              type: "apiKey",
              in: "header", 
              name: "x-api-key",
              description: "API key for service-to-service authentication"
            },
            // Admin token authentication
            adminTokenAuth: {
              type: "apiKey",
              in: "header",
              name: "x-chronopay-admin-token", 
              description: "Admin token for administrative operations"
            }
          },
          schemas: {
            ErrorEnvelope: {
              type: "object",
              properties: {
                success: {
                  type: "boolean",
                  example: false
                },
                error: {
                  type: "string",
                  description: "Human-readable error message"
                },
                code: {
                  type: "string",
                  description: "Machine-readable error code for programmatic handling"
                }
              },
              required: ["success"]
            },
            UnauthorizedError: {
              allOf: [
                { $ref: "#/components/schemas/ErrorEnvelope" },
                {
                  type: "object",
                  properties: {
                    error: {
                      type: "string",
                      enum: ["Authentication required", "Missing API key", "Missing required header: x-chronopay-admin-token"]
                    }
                  }
                }
              ]
            },
            ForbiddenError: {
              allOf: [
                { $ref: "#/components/schemas/ErrorEnvelope" },
                {
                  type: "object", 
                  properties: {
                    error: {
                      type: "string",
                      enum: ["Role is not authorized for this action", "Invalid API key", "Invalid admin token", "Insufficient permissions"]
                    }
                  }
                }
              ]
            }
          },
          responses: {
            UnauthorizedError: {
              description: "Authentication failed - missing or invalid credentials",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/UnauthorizedError" }
                }
              }
            },
            ForbiddenError: {
              description: "Authorization failed - authenticated but insufficient permissions", 
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ForbiddenError" }
                }
              }
            }
          }
        },
        security: [
          // Default security requirement - can be overridden per endpoint
          { chronoPayAuth: [] }
        ]
      },
      apis: ["./src/routes/*.ts", "./src/index.ts"],
    };

    const specs = swaggerJsdoc(options);
    app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs));
  } catch {
    // Keep the service bootable in environments where API docs deps are not installed.
  }
}

function createSlot(req: Request, res: Response) {
  const { professional, startTime, endTime } = req.body;

  if (typeof startTime !== "number" || typeof endTime !== "number") {
    return res.status(422).json({
      success: false,
      error: "startTime and endTime must be numbers",
    });
  }

  if (endTime <= startTime) {
    return res.status(422).json({
      success: false,
      error: "endTime must be greater than startTime",
    });
  }

  return res.status(201).json({
    success: true,
    slot: {
      id: 1,
      professional,
      startTime,
      endTime,
    },
  });
}

// ─── Stub routes for contract testing ──────────────────────────────────────
// These simplified implementations are for testing and contract validation only.
// Production routes are in src/routes/ and src/buyer-profile/

function createCheckoutSessionStub(req: Request, res: Response) {
  const { payment, customer } = req.body;

  if (!payment || !customer) {
    return res.status(400).json({
      success: false,
      error: "Missing required field: payment or customer",
    });
  }

  if (!payment || typeof payment !== "object") {
    return res.status(400).json({
      success: false,
      error: "Missing required payment fields",
    });
  }

  if (
    payment.amount === undefined ||
    payment.currency === undefined ||
    payment.paymentMethod === undefined
  ) {
    return res.status(400).json({
      success: false,
      error: "Missing required payment fields",
    });
  }

  if (!customer.customerId || !customer.email) {
    return res.status(400).json({
      success: false,
      error: "Missing required customer fields",
    });
  }

  // Semantic validation (422)
  if (!AmountUtils.validate(payment.amount)) {
    return res.status(422).json({
      success: false,
      error: "Amount must be a strictly positive integer in native minor units",
    });
  }

  if (!["USD", "EUR", "GBP", "XLM"].includes(payment.currency)) {
    return res.status(422).json({
      success: false,
      error: "Invalid currency",
    });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) {
    return res.status(422).json({
      success: false,
      error: "Invalid email format",
    });
  }

  // Generate proper UUID v4 format
  const generateUUID = () => {
    const chars = "0123456789abcdef";
    let uuid = "";
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) {
        uuid += "-";
      } else if (i === 14) {
        uuid += "4";
      } else if (i === 19) {
        uuid += chars[(Math.random() * 4 | 8)];
      } else {
        uuid += chars[Math.floor(Math.random() * 16)];
      }
    }
    return uuid;
  };

  const sessionId = generateUUID();
  const now = Date.now();

  const session = {
    id: sessionId,
    payment,
    customer,
    status: "pending",
    createdAt: now,
    expiresAt: now + 3600000,
    ...(req.body.metadata && { metadata: req.body.metadata }),
    ...(req.body.successUrl && { successUrl: req.body.successUrl }),
    ...(req.body.cancelUrl && { cancelUrl: req.body.cancelUrl }),
  };

  sessionStore.set(sessionId, session);

  return res.status(201).json({
    success: true,
    session,
    checkoutUrl: `http://localhost:3001/api/v1/checkout/sessions/${sessionId}/pay`,
  });
}

// In-memory session store for testing
const sessionStore = new Map<string, any>();

function getCheckoutSessionStub(req: Request, res: Response) {
  const { sessionId } = req.params;

  // UUID format validation
  if (
    !sessionId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      sessionId.toLowerCase()
    )
  ) {
    return res.status(400).json({
      success: false,
      error: "Invalid session ID format",
    });
  }

  const session = sessionStore.get(sessionId);
  if (!session) {
    return res.status(404).json({
      success: false,
      error: "Session not found",
    });
  }

  return res.status(200).json({
    success: true,
    session,
  });
}

// In-memory buyer profile store for testing
const profileStore = new Map<string, any>();
const userIdIndex = new Map<string, string>();
const emailIndex = new Map<string, string>();

// UUID v4 generator
function generateUUID() {
  const chars = "0123456789abcdef";
  let uuid = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      uuid += "-";
    } else if (i === 14) {
      uuid += "4";
    } else if (i === 19) {
      uuid += chars[(Math.random() * 4) | 8];
    } else {
      uuid += chars[Math.floor(Math.random() * 16)];
    }
  }
  return uuid;
}

function createBuyerProfileStub(req: Request, res: Response) {
  const { userId, fullName, email, phoneNumber } = req.body;

  if (!userId || !fullName || !email || !phoneNumber) {
    return res.status(400).json({
      success: false,
      error: "Missing required field",
    });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(422).json({
      success: false,
      error: "Invalid email format",
    });
  }

  if (!/^\+?[0-9\s\-()]+$/.test(phoneNumber)) {
    return res.status(422).json({
      success: false,
      error: "Invalid phone format",
    });
  }

  if (userIdIndex.has(userId) || emailIndex.has(email.toLowerCase())) {
    return res.status(409).json({
      success: false,
      error: "User or email already exists",
    });
  }

  const profileId = generateUUID();
  const now = new Date().toISOString();

  const profile = {
    id: profileId,
    userId,
    fullName,
    email: email.toLowerCase(),
    phoneNumber,
    ...(req.body.address && { address: req.body.address }),
    ...(req.body.avatarUrl && { avatarUrl: req.body.avatarUrl }),
    createdAt: now,
    updatedAt: now,
  };

  profileStore.set(profileId, profile);
  userIdIndex.set(userId, profileId);
  emailIndex.set(email.toLowerCase(), profileId);

  return res.status(201).json({
    success: true,
    data: profile,
  });
}

function getBuyerProfileStub(req: Request, res: Response) {
  const { id } = req.params;

  // UUID format validation
  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      id.toLowerCase()
    )
  ) {
    return res.status(400).json({
      success: false,
      error: "Invalid profile ID format",
    });
  }

  const profile = profileStore.get(id);
  if (!profile) {
    return res.status(404).json({
      success: false,
      error: "Profile not found",
    });
  }

  return res.status(200).json({
    success: true,
    data: profile,
  });
}

function updateBuyerProfileStub(req: Request, res: Response) {
  const { id } = req.params;

  // UUID format validation
  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      id.toLowerCase()
    )
  ) {
    return res.status(400).json({
      success: false,
      error: "Invalid profile ID format",
    });
  }

  const profile = profileStore.get(id);
  if (!profile) {
    return res.status(404).json({
      success: false,
      error: "Profile not found",
    });
  }

  if (req.body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.body.email)) {
    return res.status(422).json({
      success: false,
      error: "Invalid email format",
    });
  }

  const updated = {
    ...profile,
    ...req.body,
    updatedAt: new Date().toISOString(),
  };

  profileStore.set(id, updated);

  return res.status(200).json({
    success: true,
    data: updated,
  });
}

function deleteBuyerProfileStub(req: Request, res: Response) {
  const { id } = req.params;

  // UUID format validation
  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      id.toLowerCase()
    )
  ) {
    return res.status(400).json({
      success: false,
      error: "Invalid profile ID format",
    });
  }

  const profile = profileStore.get(id);
  if (!profile) {
    return res.status(404).json({
      success: false,
      error: "Profile not found",
    });
  }

  profileStore.delete(id);
  userIdIndex.delete(profile.userId);
  emailIndex.delete(profile.email);

  return res.status(200).json({
    success: true,
    data: { id },
  });
}

function listBuyerProfilesStub(req: Request, res: Response) {
  const profiles = Array.from(profileStore.values());

  return res.status(200).json({
    success: true,
    data: profiles,
    pagination: {
      page: 1,
      limit: 10,
      total: profiles.length,
      totalPages: Math.ceil(profiles.length / 10),
    },
  });
}

export function createApp(options: AppFactoryOptions = {}) {
  const app = express();

  // ── Trust proxy configuration (for correct client IP behind load balancer) ─────
  if (configService.trustProxy) {
    app.set('trust proxy', 1);
  }

  // ── Initialize feature flags from environment ──────────────────────────────
  initializeFeatureFlagsFromEnv();

  // ── Security headers middleware (applied early) ────────────────────────────
  app.use(securityHeaders);

  app.use(cors());

  // Content negotiation BEFORE express.json() to reject invalid Content-Type early
  if (options.enableContentNegotiation !== false) {
    app.use(
      createContentNegotiationMiddleware({
        excludePaths: options.contentNegotiationExcludePaths,
      }),
    );
  }

  app.use(express.json({ limit: "100kb" }));
  app.use(createRequestLogger());

  // ── Feature flag context middleware (makes flags available to routes) ──────
  app.use(featureFlagContextMiddleware);

  if (options.enableDocs !== false) {
    registerSwaggerDocs(app);
  }

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "chronopay-backend" });
  });

  app.get("/api/v1/slots", (_req, res) => {
    // Set cache header (mock implementation - always HIT for simplicity)
    res.set("X-Cache", "MISS");
    res.json({ slots: [] });
  });

  app.post(
    "/api/v1/slots",
    requireApiKey(options.apiKey),
    createAuthAwareRateLimiter(),
    validateRequiredFields(["professional", "startTime", "endTime"]),
    createSlot,
  );

  // ── Booking intents routes ─────────────────────────────────────────────────
  app.use("/api/v1/booking-intents", createBookingIntentsRouter());
  app.use("/api/v1/checkout", checkoutRouter);

  if (options.enableTestRoutes) {
    app.get("/__test__/explode", () => {
      throw new Error("Intentional test fault");
    });
  }

  // Ensure all API responses declare Content-Type: application/json
  app.use((_req, res, next) => {
    res.setHeader("Content-Type", "application/json");
    next();
  });

  app.use(notFoundHandler);
  app.use(jsonParseErrorHandler);
  app.use(genericErrorHandler);

  return app;
}
