import fs from "fs/promises";
import path from "path";
import { logger } from "../utils/logger.js";

import {
  createAuditEvent,
  encodeAuditEvent,
  AuditEventPayloadV1,
  AuditEventV1,
  LegacyAuditLogEntry,
} from "../utils/auditEventValidator.js";
import type {
  ImpersonationAuditContext,
} from "../types/impersonation.types.js";
import {
  IMPERSONATION_AUDIT_ACTIONS,
  ImpersonationAuditAction,
} from "../types/auditEvent.js";

/**
 * Legacy audit log entry (for backward compatibility)
 * @deprecated Use AuditEventV1 instead
 */
export interface AuditLogEntry {
  timestamp: string;
  action: string;
  actorIp?: string;
  resource?: string;
  status: string | number;
  metadata?: Record<string, any>;
}

export interface AuditLoggerOptions {
  /** Path to the audit log file */
  filePath?: string;
  /** Service name for audit events */
  service?: string;
  /** Environment (dev, staging, prod, test) */
  environment?: string;
}

export class AuditLogger {
  private logFilePath: string;
  private service: string;
  private environment: string;

  constructor(options?: AuditLoggerOptions) {
    // Default to 'logs/audit.log' in project root
    const cwd = typeof process !== "undefined" ? process.cwd() : ".";
    this.logFilePath = options?.filePath || path.join(cwd, "logs", "audit.log");
    this.service = options?.service || "chronopay-backend";
    this.environment = options?.environment || "dev";
  }

  /**
   * Appends an audit log entry to the JSONL file using the versioned schema.
   * Resolves asynchronously and does not throw errors if writing fails.
   * 
   * @param action - The action being performed
   * @param data - Versioned payload data
   * @param options - Additional event options (actorIp, resource, status)
   */
  public async log(
    action: string,
    data: Omit<AuditEventPayloadV1, "method"> & { method?: string },
    options?: {
      actorIp?: string;
      resource?: string;
      status?: number | string;
    }
  ): Promise<void>;

  /**
   * Legacy method for backward compatibility.
   * Logs in the old format and migrates to the new versioned format.
   * @deprecated Use the versioned log method instead
   */
  public async log(entry: Omit<AuditLogEntry, "timestamp">): Promise<void>;

  /**
   * Implementation of both overloads
   */
  public async log(
    actionOrEntry: string | Omit<AuditLogEntry, "timestamp">,
    data?: Omit<AuditEventPayloadV1, "method"> & { method?: string },
    options?: {
      actorIp?: string;
      resource?: string;
      status?: number | string;
    }
  ): Promise<void> {
    let logLine: string;

    // Detect which overload is being called
    if (typeof actionOrEntry === "string") {
      // New versioned format
      const event: AuditEventV1 = createAuditEvent(
        actionOrEntry,
        data || {},
        {
          ...options,
          service: this.service,
          environment: this.environment,
        }
      );
      logLine = encodeAuditEvent(event) + "\n";
    } else {
      // Legacy format - migrate to versioned format
      const legacyEntry: LegacyAuditLogEntry = {
        timestamp: new Date().toISOString(),
        ...actionOrEntry,
      };
      
      // Migrate to versioned format
      const event = createAuditEvent(
        legacyEntry.action,
        {
          method: (legacyEntry.metadata as any)?.method,
          body: (legacyEntry.metadata as any)?.body,
          context: legacyEntry.metadata,
        },
        {
          actorIp: legacyEntry.actorIp,
          resource: legacyEntry.resource,
          status: legacyEntry.status,
          service: this.service,
          environment: this.environment,
        }
      );
      logLine = encodeAuditEvent(event) + "\n";
    }

    try {
      await fs.mkdir(path.dirname(this.logFilePath), { recursive: true });
      await fs.appendFile(this.logFilePath, logLine, "utf8");
    } catch (error) {
      // Failure mode handling: We log to console rather than breaking the application flow
      logger.error({ error }, "Failed to write to audit log:");
    }
  }

  public getLogFilePath(): string {
    return this.logFilePath;
  }

  /**
   * Convenience helper for emitting impersonation lifecycle events.
   *
   * Wraps the standard `log` method with a pre-built payload structure that
   * includes the impersonation context in `data.context` so review tooling
   * can filter events by session ID without knowing the internal envelope.
   *
   * @param action  - One of IMPERSONATION_AUDIT_ACTIONS
   * @param context - Impersonation correlation fields
   * @param extra   - Optional extra payload fields merged into `data`
   * @param status  - HTTP status or logical status (default 200)
   */
  public async logImpersonationEvent(
    action: ImpersonationAuditAction | string,
    context: ImpersonationAuditContext,
    extra?: Record<string, unknown>,
    status: number | string = 200,
  ): Promise<void> {
    return this.log(
      action,
      {
        context: {
          impersonationSessionId: context.impersonationSessionId,
          adminId: context.adminId,
          targetUserId: context.targetUserId,
          ...extra,
        },
      },
      { status },
    );
  }
}

// Export a default singleton instance for use across the application
export const defaultAuditLogger = new AuditLogger();
