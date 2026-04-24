import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";

import { logInfo } from "./utils/logger.js";
import {
  createRequestLogger,
  errorLoggerMiddleware,
} from "./middleware/requestLogger.js";
import { validateRequiredFields } from "./middleware/validation.js";
import { loadEnvConfig } from "./config/env.js";
import { requireAuthenticatedActor } from "./middleware/auth.js";
import { InMemorySlotRepository } from "./modules/slots/slot-repository.js";

export function createApp(options?: {
  slotRepository?: InMemorySlotRepository;
}) {
  const app = express();
  const slotRepository =
    options?.slotRepository ?? new InMemorySlotRepository();

  app.use(createRequestLogger());
  app.use(cors());
  app.use(express.json());

  const swaggerOptions = {
    swaggerDefinition: {
      openapi: "3.0.0",
      info: { title: "ChronoPay API", version: "1.0.0" },
    },
    apis: ["./src/index.ts"], // adjust if needed
  };

  const specs = swaggerJsdoc(swaggerOptions);
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs));

  app.get("/health", (_req, res) => {
    const healthStatus = { status: "ok", service: "chronopay-backend" };
    logInfo("Health check endpoint called", { endpoint: "/health" });
    res.json(healthStatus);
  });

  app.get("/api/v1/slots", (_req, res) => {
    logInfo("Slots endpoint called", { endpoint: "/api/v1/slots" });
    res.json({ slots: slotRepository.list() });
  });

  app.post(
    "/api/v1/slots",
    requireAuthenticatedActor,
    validateRequiredFields(["professional", "startTime", "endTime"]),
    async (req, res) => {
      const { professional, startTime, endTime } = req.body;

      const slot = {
        id: Date.now(),
        professional,
        startTime,
        endTime,
      };

      res.status(201).json({
        success: true,
        slot,
      });
    },
  );

  app.use(errorLoggerMiddleware);

  return app;
}

const config = loadEnvConfig();
const app = createApp();

if (config.nodeEnv !== "test") {
  const PORT = config.port ?? 3000;
  app.listen(PORT, () => {
    logInfo(`ChronoPay API listening on http://localhost:${PORT}`, {
      port: PORT,
      environment: config.nodeEnv || "development",
    });
  });
}

export default app;
