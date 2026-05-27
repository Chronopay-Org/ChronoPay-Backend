import { Request, Response, NextFunction } from "express";
import { defaultAuditLogger } from "../services/auditLogger.js";
import { redactSensitiveData } from "../utils/auditEventValidator.js";

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
      // Use the new versioned audit event format
      defaultAuditLogger.log(
        action,
        {
          method: req.method,
          body: req.method !== "GET" ? redactSensitiveData(req.body) as Record<string, unknown> : undefined,
        },
        {
          actorIp: req.ip || req.socket.remoteAddress,
          resource: req.originalUrl,
          status: res.statusCode,
        }
      );
    });

    next();
  };
};
