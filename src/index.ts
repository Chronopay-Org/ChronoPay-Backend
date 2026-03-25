import express from "express";
import cors from "cors";
import { logInfo } from "./utils/logger.js";
import {
  createRequestLogger,
  errorLoggerMiddleware,
} from "./middleware/requestLogger.js";
import { validateRequiredFields } from "./middleware/validation";

const app = express();
const PORT = process.env.PORT ?? 3001;

// Request logging middleware (must be first)
app.use(createRequestLogger());

app.use(cors());
app.use(express.json());

import swaggerUi from "swagger-ui-express";
import swaggerJsdoc from "swagger-jsdoc";

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

export default app;
