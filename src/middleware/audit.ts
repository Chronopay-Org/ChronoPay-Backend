import { Request, Response, NextFunction } from "express";
import { defaultAuditLogger } from "../services/auditLogger.js";

/**
 * Express middleware to automatically log actions to the audit log
 * after the request finishes to ensure accurate status reporting.
 *
 * @param action - A descriptive name for the action being performed (e.g. 'CREATE_SLOT')
 */
export const auditMiddleware = (action: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    res.on("finish", () => {
      // Asynchronously log the finished request without blocking the response
      defaultAuditLogger.log({
        action,
        actorIp: req.ip || req.socket.remoteAddress,
        resource: req.originalUrl,
        status: res.statusCode,
        metadata: {
          method: req.method,
          // Important: Limit logged body fields in production to prevent leaking PII/auth secrets
          // Here we omit 'password' or similar sensitive keys if present
          body: req.method !== "GET" ? maskSensitiveData(req.body) : undefined,
        },
      });
    });

    next();
  };
};

function maskSensitiveData(body: any): any {
  if (!body) return body;
  const masked = { ...body };
  if ("password" in masked) {
    masked.password = "***";
  }
  return masked;
}
