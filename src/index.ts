import express from "express";
import cors from "cors";
import { createRequire } from "node:module";
import { loadEnvConfig, type EnvConfig } from "./config/env.js";
import { validateRequiredFields } from "./middleware/validation.js";
import {
  featureFlagContextMiddleware,
  initializeFeatureFlagsFromEnv,
  requireFeatureFlag,
} from "./middleware/featureFlags.js";

const config = loadEnvConfig();

interface AppListener {
  listen(port: number, callback?: () => void): unknown;
}

interface Slot {
  id: number;
  professional: string;
  startTime: number;
  endTime: number;
}

const slotStore: Slot[] = [];
let nextSlotId = 1;

export function __resetSlotsForTests(): void {
  slotStore.length = 0;
  nextSlotId = 1;
}

function registerSwaggerDocs(app: express.Express): void {
  const require = createRequire(import.meta.url);

  try {
    const swaggerUi = require("swagger-ui-express");
    const swaggerJsdoc = require("swagger-jsdoc");
    const options = {
      swaggerDefinition: {
        openapi: "3.0.0",
        info: { title: "ChronoPay API", version: "1.0.0" },
      },
      apis: ["./src/routes/*.ts"],
    };

    const specs = swaggerJsdoc(options);
    app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs));
  } catch {
    // Keep service/test bootable when swagger packages are unavailable.
  }
}

export function createApp() {
  initializeFeatureFlagsFromEnv();

  const app = express();

  app.use(cors());
  app.use(express.json());

  registerSwaggerDocs(app);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "chronopay-backend" });
  });

  app.get("/api/v1/slots", (_req, res) => {
    res.json({ slots: [...slotStore] });
  });

  app.post(
    "/api/v1/slots",
    featureFlagContextMiddleware,
    requireFeatureFlag("CREATE_SLOT"),
    validateRequiredFields(["professional", "startTime", "endTime"]),
    (req, res) => {
      const { professional, startTime, endTime } = req.body as {
        professional: string;
        startTime: number;
        endTime: number;
      };

      if (typeof startTime !== "number" || typeof endTime !== "number") {
        res.status(422).json({
          success: false,
          error: "startTime and endTime must be numbers",
        });
        return;
      }

      if (endTime <= startTime) {
        res.status(422).json({
          success: false,
          error: "endTime must be greater than startTime",
        });
        return;
      }

      const slot: Slot = {
        id: nextSlotId++,
        professional,
        startTime,
        endTime,
      };
      slotStore.push(slot);

      res.status(201).json({
        success: true,
        slot,
      });
    },
  );

  return app;
}

export function startServer(app: AppListener, runtimeConfig: EnvConfig) {
  return app.listen(runtimeConfig.port, () => {
    console.log(`ChronoPay API listening on http://localhost:${runtimeConfig.port}`);
  });
}

const app = createApp();

if (config.nodeEnv !== "test") {
  startServer(app, config);
}

export default app;
