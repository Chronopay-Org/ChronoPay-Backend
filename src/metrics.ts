import { Registry, collectDefaultMetrics, Histogram, Counter } from "prom-client";
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

// ─── Slot cache metrics ───────────────────────────────────────────────────────

/**
 * Counter incremented on every slot-list cache HIT.
 */
export const slotCacheHits = new Counter({
  name: "slot_cache_hits_total",
  help: "Total number of slot list cache hits",
  registers: [register],
});

/**
 * Counter incremented on every slot-list cache MISS (origin fetch triggered).
 */
export const slotCacheMisses = new Counter({
  name: "slot_cache_misses_total",
  help: "Total number of slot list cache misses",
  registers: [register],
});

/**
 * Counter incremented each time a concurrent request is coalesced into an
 * existing in-flight fetch (stampede prevented).
 */
export const slotCacheStampedeBlocked = new Counter({
  name: "slot_cache_stampede_blocked_total",
  help: "Total number of concurrent requests coalesced by single-flight stampede protection",
  registers: [register],
});

/** Convenience helpers used by slotCache.ts */
export function recordCacheHit(): void {
  slotCacheHits.inc();
}

export function recordCacheMiss(): void {
  slotCacheMisses.inc();
}

export function recordStampedeBlocked(): void {
  slotCacheStampedeBlocked.inc();
}

// ─── Slow-query metrics ───────────────────────────────────────────────────────

/**
 * Counter incremented each time a query exceeds the slow-query threshold.
 */
export const slowQueryCounter = new Counter({
  name: "db_slow_queries_total",
  help: "Total number of database queries that exceeded the slow-query threshold",
  registers: [register],
});

/**
 * Histogram tracking duration (in milliseconds) of slow queries.
 */
export const slowQueryDuration = new Histogram({
  name: "db_slow_query_duration_ms",
  help: "Duration in milliseconds of slow database queries",
  buckets: [100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [register],
});

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
