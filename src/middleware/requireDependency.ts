/**
 * Middleware factory that fails closed with a consistent 503 payload when a
 * named dependency (redis | db) is unavailable.
 *
 * Usage:
 *   router.post("/api/v1/slots", requireDependency("redis"), handler);
 *
 * 503 payload shape (matches featureFlags.ts convention):
 *   { success: false, code: "DEPENDENCY_UNAVAILABLE", error: "<message>" }
 *
 * Security note: the error message names the dependency type only — no
 * connection strings, hostnames, or internal error details are exposed.
 */

import type { NextFunction, Request, Response } from "express";
import { isDependencyAvailable, type Dependency } from "./dependencyStatus.js";

const DEPENDENCY_LABELS: Record<Dependency, string> = {
  redis: "Redis",
  db: "Database",
};

export function requireDependency(dep: Dependency) {
  return async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    const available = await isDependencyAvailable(dep);
    if (!available) {
      res.status(503).json({
        success: false,
        code: "DEPENDENCY_UNAVAILABLE",
        error: `${DEPENDENCY_LABELS[dep]} is currently unavailable`,
      });
      return;
    }
    next();
  };
}
