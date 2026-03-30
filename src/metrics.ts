import { Registry, collectDefaultMetrics, Histogram } from "prom-client";
import { Request, Response, NextFunction } from "express";

/**
 * Prometheus metrics registry for the ChronoPay Backend.
 */
export const register = new Registry();

// Add default metrics (CPU, Memory, etc.)
collectDefaultMetrics({ register });

/**
 * Histogram to track HTTP request duration in seconds.
 */
let httpRequestDurationMicroseconds = register.getSingleMetric("http_request_duration_seconds") as Histogram;

if (!httpRequestDurationMicroseconds) {
  httpRequestDurationMicroseconds = new Histogram({
    name: "http_request_duration_seconds",
    help: "Duration of HTTP requests in seconds",
    labelNames: ["method", "route", "status_code"],
    buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10], // buckets for response time from 0.1s to 10s
    registers: [register],
  });
}

export { httpRequestDurationMicroseconds };

/**
 * Express middleware to track HTTP request duration.
 */
export const metricsMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const start = process.hrtime();

  res.on("finish", () => {
    const duration = process.hrtime(start);
    const durationInSeconds = duration[0] + duration[1] / 1e9;
    
    // Determine the route pattern
    const route = req.route ? req.route.path : req.path;
    
    httpRequestDurationMicroseconds
      .labels(req.method, route, res.statusCode.toString())
      .observe(durationInSeconds);
  });

  next();
};
