import express from "express";
import cors from "cors";
import { logInfo } from "./utils/logger.js";
import {
  createRequestLogger,
  errorLoggerMiddleware,
} from "./middleware/requestLogger.js";
import { validateRequiredFields } from "./middleware/validation";

import { loadEnvConfig, type EnvConfig } from "./config/env.js";
import { validateRequiredFields } from "./middleware/validation.js";

// Request logging middleware (must be first)
app.use(createRequestLogger());

app.use(cors());
app.use(express.json());
app.use(metricsMiddleware);

/**
 * @api {get} /metrics Get Prometheus metrics
 * @apiName GetMetrics
 * @apiGroup Monitoring
 * @apiDescription Exposes application metrics in Prometheus format.
 */
app.get("/metrics", async (_req, res) => {
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err);
  }
});

interface AppListener {
  listen(port: number, callback?: () => void): unknown;
}

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  const options = {
    swaggerDefinition: {
      openapi: "3.0.0",
      info: { title: "ChronoPay API", version: "1.0.0" },
    },
    apis: ["./src/routes/*.ts"], // adjust if needed
  };

  const specs = swaggerJsdoc(options);
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "chronopay-backend" });
  });

  app.get("/api/v1/slots", (_req, res) => {
    res.json({ slots: [] });
  });

  app.post(
    "/api/v1/slots",
    validateRequiredFields(["professional", "startTime", "endTime"]),
    (req, res) => {
      const { professional, startTime, endTime } = req.body;

      res.status(201).json({
        success: true,
        slot: {
          id: 1,
          professional,
          startTime,
          endTime,
        },
      });
    },
  );

const options = {
  swaggerDefinition: {
    openapi: "3.0.0",
    info: { title: "ChronoPay API", version: "1.0.0" },
  },
  apis: ["./src/routes/*.ts"], // adjust if needed
};

const specs = swaggerJsdoc(options);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs));

app.get("/health", (_req, res) => {
  const healthStatus = { status: "ok", service: "chronopay-backend" };
  logInfo("Health check endpoint called", { endpoint: "/health" });
  res.json(healthStatus);
});

app.get("/api/v1/slots", (_req, res) => {
  logInfo("Slots endpoint called", { endpoint: "/api/v1/slots" });
  res.json({ slots: [] });
});

// Error handling middleware (must be last)
app.use(errorLoggerMiddleware);
app.post(
  "/api/v1/slots",
  validateRequiredFields(["professional", "startTime", "endTime"]),
  (req, res) => {
    const { professional, startTime, endTime } = req.body;

    res.status(201).json({
      success: true,
      slot: {
        id: 1,
        professional,
        startTime,
        endTime,
      },
    });
  },
);

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    logInfo(`ChronoPay API listening on http://localhost:${PORT}`, {
      port: PORT,
      environment: process.env.NODE_ENV || "development",
    });
  });
}

const app = createApp();

if (config.nodeEnv !== "test") {
  startServer(app, config);
}

export default app;
