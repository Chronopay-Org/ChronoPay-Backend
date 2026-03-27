import express from "express";
import cors from "cors";
import { validateRequiredFields } from "./middleware/validation";
import { tracingMiddleware } from "./tracing/middleware";
import { withSpan } from "./tracing/hooks";

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(tracingMiddleware);
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
  res.json({ status: "ok", service: "chronopay-backend" });
});

app.get("/api/v1/slots", (_req, res) => {
  res.json({ slots: [] });
});

app.post(
  "/api/v1/slots",
  validateRequiredFields(["professional", "startTime", "endTime"]),
  async (req, res) => {
    const { professional, startTime, endTime } = req.body;

    // Simulate business logic wrapped in a tracing span
    const slot = await withSpan(
      "create-slot",
      { professional, startTime, endTime },
      async () => {
        // Business logic would go here
        return {
          id: 1,
          professional,
          startTime,
          endTime,
        };
      },
    );

    res.status(201).json({
      success: true,
      slot,
    });
  },
);

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`ChronoPay API listening on http://localhost:${PORT}`);
  });
}

export default app;
