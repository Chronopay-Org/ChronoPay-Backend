import express from "express";
import cors from "cors";
import { validateRequiredFields } from "./middleware/validation";
import { timeoutMiddleware } from "./middleware/timeout";
import { errorHandler } from "./middleware/errorHandler";


const app = express();
const PORT = process.env.PORT ?? 3001;


app.use(cors());
app.use(express.json());
// Apply timeout middleware globally (default timeout)
app.use(timeoutMiddleware());

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


// Example: override timeout for health route (short timeout for demo)
app.get(
  "/health",
  timeoutMiddleware({ timeoutMs: 2000 }),
  (_req, res) => {
    res.json({ status: "ok", service: "chronopay-backend" });
  },
);


app.get("/api/v1/slots", (req, res) => {
  res.json({ slots: [] });
});


app.post(
  "/api/v1/slots",
  // Example: per-route override (longer timeout for slot creation)
  timeoutMiddleware({ timeoutMs: 15000 }),
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


// Error handler (must be last)
app.use(errorHandler);

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`ChronoPay API listening on http://localhost:${PORT}`);
  });
}

export default app;
