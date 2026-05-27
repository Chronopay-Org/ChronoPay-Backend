import { createRequire } from "node:module";
import cors from "cors";
import express, { Request, Response } from "express";
import { requireApiKey } from "./middleware/apiKeyAuth.js";
import {
  genericErrorHandler,
  jsonParseErrorHandler,
  notFoundHandler,
} from "./middleware/errorHandling.js";
import { validateRequiredFields } from "./middleware/validation.js";

export interface AppFactoryOptions {
  apiKey?: string;
  enableDocs?: boolean;
  enableTestRoutes?: boolean;
  slotRepository?: any;
  bookingIntentService?: any;
}

function registerSwaggerDocs(app: express.Express) {
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

export function createApp(options: AppFactoryOptions = {}) {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "100kb" }));

  if (options.enableDocs !== false) {
    registerSwaggerDocs(app);
  }

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "chronopay-backend" });
  });

  app.get("/api/v1/slots", (_req, res) => {
    res.json({ slots: [] });
  });

  app.post(
    "/api/v1/slots",
    requireApiKey(options.apiKey),
    validateRequiredFields(["professional", "startTime", "endTime"]),
    createSlot,
  );

  if (options.enableTestRoutes) {
    app.get("/__test__/explode", () => {
      throw new Error("Intentional test fault");
    });
  }

  app.use(notFoundHandler);
  app.use(jsonParseErrorHandler);
  app.use(genericErrorHandler);

  return app;
}
