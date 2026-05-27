/**
 * Audit Event Schema Versioning
 * 
 * This module defines versioned audit event schemas with a stable envelope structure.
 * All audit events follow a consistent envelope format with versioned payload schemas.
 * 
 * Compatibility Policy:
 * - Envelope structure is stable across versions
 * - Payload schemas evolve with semantic versioning
 * - Consumers must handle unknown fields gracefully
 * - Old versions are supported for at least 6 months after deprecation
 */

/**
 * Current schema version
 * Format: MAJOR.MINOR.PATCH
 * - MAJOR: Breaking changes to envelope or required fields
 * - MINOR: Non-breaking additions to payload schema
 * - PATCH: Bug fixes or clarifications
 */
export const AUDIT_SCHEMA_VERSION = "1.0.0";

/**
 * Supported schema versions for compatibility
 * Consumers can process events from these versions
 */
export const SUPPORTED_SCHEMA_VERSIONS = ["1.0.0"];

/**
 * Deprecated schema versions (still readable but not writable)
 */
export const DEPRECATED_SCHEMA_VERSIONS: string[] = [];

/**
 * Stable event envelope structure
 * This structure remains consistent across schema versions
 */
export interface AuditEventEnvelope {
  /** Schema version of the payload */
  version: string;
  /** ISO 8601 timestamp when the event occurred */
  timestamp: string;
  /** Unique event identifier (UUID v4) */
  eventId: string;
  /** The action being performed */
  action: string;
  /** IP address of the actor (may be redacted) */
  actorIp?: string;
  /** Resource being acted upon */
  resource?: string;
  /** HTTP status code or operation status */
  status: number | string;
  /** Versioned event payload */
  data: Record<string, unknown>;
  /** Service that generated the event */
  service: string;
  /** Environment (dev, staging, prod) */
  environment: string;
}

/**
 * Audit event payload schema v1.0.0
 * This is the initial version with basic audit fields
 */
export interface AuditEventPayloadV1 extends Record<string, unknown> {
  /** HTTP method if applicable */
  method?: string;
  /** Request body (redacted) */
  body?: Record<string, unknown>;
  /** Additional context */
  context?: Record<string, unknown>;
  /** User ID if authenticated */
  userId?: string;
  /** Session ID for correlation */
  sessionId?: string;
}

/**
 * Complete audit event type for v1.0.0
 */
export interface AuditEventV1 extends AuditEventEnvelope {
  version: "1.0.0";
  data: AuditEventPayloadV1;
}

/**
 * Union type of all supported audit event versions
 */
export type AuditEvent = AuditEventV1;

/**
 * Legacy audit log entry (pre-versioning)
 * Used for migration and backward compatibility
 */
export interface LegacyAuditLogEntry {
  timestamp: string;
  action: string;
  actorIp?: string;
  resource?: string;
  status: string | number;
  metadata?: Record<string, any>;
}

/**
 * Error types for validation
 */
export class AuditEventValidationError extends Error {
  constructor(
    message: string,
    public readonly field?: string,
    public readonly value?: unknown
  ) {
    super(message);
    this.name = "AuditEventValidationError";
  }
}

export class AuditEventVersionError extends Error {
  constructor(message: string, public readonly version: string) {
    super(message);
    this.name = "AuditEventVersionError";
  }
}
