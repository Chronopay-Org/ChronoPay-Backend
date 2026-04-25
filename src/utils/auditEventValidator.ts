/**
 * Audit Event Validator and Encoder
 * 
 * Centralized validation, encoding, and redaction for audit events.
 * Enforces schema compliance, data minimization, and security rules.
 */

import {
  AuditEvent,
  AuditEventEnvelope,
  AuditEventPayloadV1,
  AuditEventV1,
  AuditEventValidationError,
  AuditEventVersionError,
  AUDIT_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  DEPRECATED_SCHEMA_VERSIONS,
  LegacyAuditLogEntry,
} from "../types/auditEvent.js";

// Re-export types for convenience
export type {
  AuditEvent,
  AuditEventEnvelope,
  AuditEventPayloadV1,
  AuditEventV1,
  LegacyAuditLogEntry,
};
export {
  AuditEventValidationError,
  AuditEventVersionError,
  AUDIT_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  DEPRECATED_SCHEMA_VERSIONS,
};

/**
 * Generate a UUID v4
 * Simple implementation without external dependencies
 */
function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Sensitive field patterns that must be redacted
 * These patterns match common PII and credential fields
 */
const SENSITIVE_FIELD_PATTERNS = [
  /^password$/i,
  /^passwd$/i,
  /^secret$/i,
  /^token$/i,
  /^api[_-]?key$/i,
  /^authorization$/i,
  /^auth$/i,
  /^credit[_-]?card$/i,
  /^cc[_-]?number$/i,
  /^cvc$/i,
  /^cvv$/i,
  /^ssn$/i,
  /^social[_-]?security$/i,
  /^pin$/i,
  /^otp$/i,
  /^totp$/i,
  /^private[_-]?key$/i,
];

/**
 * Fields that are always allowed (never redacted)
 */
const ALLOWED_FIELDS = [
  "id",
  "name",
  "email",
  "action",
  "resource",
  "status",
  "timestamp",
  "method",
  "userId",
  "sessionId",
];

/**
 * Maximum size for audit event payload (in bytes)
 * Prevents log injection and excessive storage usage
 */
const MAX_PAYLOAD_SIZE = 10 * 1024; // 10KB

/**
 * Redaction value used for sensitive data
 */
const REDACTION_MARKER = "***REDACTED***";

/**
 * Validates and redacts sensitive data in an object
 * Recursively processes nested objects and arrays
 */
export function redactSensitiveData(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === "string") {
    // Check if the string itself might be sensitive (e.g., long base64 tokens)
    if (data.length > 256) {
      return REDACTION_MARKER;
    }
    return data;
  }

  if (typeof data === "number" || typeof data === "boolean") {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item));
  }

  if (typeof data === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      // Check if field matches sensitive pattern
      const isSensitive = SENSITIVE_FIELD_PATTERNS.some((pattern) =>
        pattern.test(key)
      );

      if (isSensitive) {
        redacted[key] = REDACTION_MARKER;
      } else {
        redacted[key] = redactSensitiveData(value);
      }
    }
    return redacted;
  }

  // Unknown types are redacted for safety
  return REDACTION_MARKER;
}

/**
 * Validates that a field name is not sensitive
 */
export function isSensitiveField(fieldName: string): boolean {
  return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(fieldName));
}

/**
 * Validates the envelope structure (version-independent)
 */
export function validateEnvelope(envelope: AuditEventEnvelope): void {
  if (!envelope.version || typeof envelope.version !== "string") {
    throw new AuditEventValidationError(
      "version is required and must be a string",
      "version",
      envelope.version
    );
  }

  if (!envelope.timestamp || typeof envelope.timestamp !== "string") {
    throw new AuditEventValidationError(
      "timestamp is required and must be a string",
      "timestamp",
      envelope.timestamp
    );
  }

  // Validate ISO 8601 timestamp format
  if (!isValidISO8601(envelope.timestamp)) {
    throw new AuditEventValidationError(
      "timestamp must be in ISO 8601 format",
      "timestamp",
      envelope.timestamp
    );
  }

  if (!envelope.eventId || typeof envelope.eventId !== "string") {
    throw new AuditEventValidationError(
      "eventId is required and must be a string",
      "eventId",
      envelope.eventId
    );
  }

  // Validate UUID format
  if (!isValidUUID(envelope.eventId)) {
    throw new AuditEventValidationError(
      "eventId must be a valid UUID v4",
      "eventId",
      envelope.eventId
    );
  }

  if (!envelope.action || typeof envelope.action !== "string") {
    throw new AuditEventValidationError(
      "action is required and must be a string",
      "action",
      envelope.action
    );
  }

  if (envelope.action.length > 256) {
    throw new AuditEventValidationError(
      "action must not exceed 256 characters",
      "action",
      envelope.action
    );
  }

  if (envelope.actorIp !== undefined) {
    if (typeof envelope.actorIp !== "string") {
      throw new AuditEventValidationError(
        "actorIp must be a string if provided",
        "actorIp",
        envelope.actorIp
      );
    }
    // Basic IP validation (accepts IPv4 and IPv6)
    if (!isValidIPAddress(envelope.actorIp)) {
      throw new AuditEventValidationError(
        "actorIp must be a valid IP address",
        "actorIp",
        envelope.actorIp
      );
    }
  }

  if (envelope.resource !== undefined) {
    if (typeof envelope.resource !== "string") {
      throw new AuditEventValidationError(
        "resource must be a string if provided",
        "resource",
        envelope.resource
      );
    }
    if (envelope.resource.length > 2048) {
      throw new AuditEventValidationError(
        "resource must not exceed 2048 characters",
        "resource",
        envelope.resource
      );
    }
  }

  if (envelope.status === undefined) {
    throw new AuditEventValidationError(
      "status is required",
      "status",
      envelope.status
    );
  }

  if (typeof envelope.status !== "number" && typeof envelope.status !== "string") {
    throw new AuditEventValidationError(
      "status must be a number or string",
      "status",
      envelope.status
    );
  }

  if (!envelope.data || typeof envelope.data !== "object") {
    throw new AuditEventValidationError(
      "data is required and must be an object",
      "data",
      envelope.data
    );
  }

  if (!envelope.service || typeof envelope.service !== "string") {
    throw new AuditEventValidationError(
      "service is required and must be a string",
      "service",
      envelope.service
    );
  }

  if (!envelope.environment || typeof envelope.environment !== "string") {
    throw new AuditEventValidationError(
      "environment is required and must be a string",
      "environment",
      envelope.environment
    );
  }

  // Validate environment is one of allowed values
  const allowedEnvironments = ["dev", "staging", "prod", "test"];
  if (!allowedEnvironments.includes(envelope.environment)) {
    throw new AuditEventValidationError(
      `environment must be one of: ${allowedEnvironments.join(", ")}`,
      "environment",
      envelope.environment
    );
  }
}

/**
 * Validates v1.0.0 payload schema
 */
export function validatePayloadV1(payload: AuditEventPayloadV1): void {
  if (payload.method !== undefined) {
    if (typeof payload.method !== "string") {
      throw new AuditEventValidationError(
        "method must be a string if provided",
        "data.method",
        payload.method
      );
    }
    const allowedMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
    if (!allowedMethods.includes(payload.method)) {
      throw new AuditEventValidationError(
        `method must be one of: ${allowedMethods.join(", ")}`,
        "data.method",
        payload.method
      );
    }
  }

  if (payload.body !== undefined) {
    if (typeof payload.body !== "object" || payload.body === null) {
      throw new AuditEventValidationError(
        "body must be an object if provided",
        "data.body",
        payload.body
      );
    }
  }

  if (payload.context !== undefined) {
    if (typeof payload.context !== "object" || payload.context === null) {
      throw new AuditEventValidationError(
        "context must be an object if provided",
        "data.context",
        payload.context
      );
    }
  }

  if (payload.userId !== undefined) {
    if (typeof payload.userId !== "string") {
      throw new AuditEventValidationError(
        "userId must be a string if provided",
        "data.userId",
        payload.userId
      );
    }
  }

  if (payload.sessionId !== undefined) {
    if (typeof payload.sessionId !== "string") {
      throw new AuditEventValidationError(
        "sessionId must be a string if provided",
        "data.sessionId",
        payload.sessionId
      );
    }
  }
}

/**
 * Validates a complete audit event based on its version
 */
export function validateAuditEvent(event: AuditEvent): void {
  // Validate envelope first (version-independent)
  validateEnvelope(event);

  // Check if version is supported
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(event.version)) {
    if (DEPRECATED_SCHEMA_VERSIONS.includes(event.version)) {
      throw new AuditEventVersionError(
        `Schema version ${event.version} is deprecated and no longer supported for writing`,
        event.version
      );
    }
    throw new AuditEventVersionError(
      `Unsupported schema version: ${event.version}. Supported versions: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}`,
      event.version
    );
  }

  // Validate version-specific payload
  switch (event.version) {
    case "1.0.0":
      validatePayloadV1(event.data as AuditEventPayloadV1);
      break;
    default:
      throw new AuditEventVersionError(
        `No validator implemented for version: ${event.version}`,
        event.version
      );
  }

  // Validate payload size
  const payloadSize = JSON.stringify(event.data).length;
  if (payloadSize > MAX_PAYLOAD_SIZE) {
    throw new AuditEventValidationError(
      `Payload size (${payloadSize} bytes) exceeds maximum allowed size (${MAX_PAYLOAD_SIZE} bytes)`,
      "data",
      payloadSize
    );
  }
}

/**
 * Creates a new audit event with proper structure and validation
 * Automatically generates eventId, timestamp, and applies redaction
 */
export function createAuditEvent(
  action: string,
  data: Omit<AuditEventPayloadV1, "method"> & { method?: string },
  options?: {
    actorIp?: string;
    resource?: string;
    status?: number | string;
    service?: string;
    environment?: string;
  }
): AuditEventV1 {
  const service = options?.service || "chronopay-backend";
  const environment = options?.environment || "dev";

  // Redact sensitive data before creating event
  const redactedData = redactSensitiveData(data) as AuditEventPayloadV1;

  const event: AuditEventV1 = {
    version: AUDIT_SCHEMA_VERSION as "1.0.0",
    timestamp: new Date().toISOString(),
    eventId: generateUUID(),
    action,
    actorIp: options?.actorIp,
    resource: options?.resource,
    status: options?.status || "unknown",
    data: redactedData,
    service,
    environment,
  };

  // Validate the created event
  validateAuditEvent(event);

  return event;
}

/**
 * Encodes an audit event to JSONL format for file storage
 */
export function encodeAuditEvent(event: AuditEvent): string {
  validateAuditEvent(event);
  return JSON.stringify(event);
}

/**
 * Decodes an audit event from JSONL format
 * Performs validation to ensure schema compliance
 */
export function decodeAuditEvent(json: string): AuditEvent {
  try {
    const event = JSON.parse(json) as AuditEvent;
    validateAuditEvent(event);
    return event;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new AuditEventValidationError(
        "Invalid JSON format",
        undefined,
        json
      );
    }
    throw error;
  }
}

/**
 * Migrates a legacy audit log entry to the new versioned format
 */
export function migrateLegacyEntry(
  legacy: LegacyAuditLogEntry,
  options?: {
    service?: string;
    environment?: string;
  }
): AuditEventV1 {
  const service = options?.service || "chronopay-backend";
  const environment = options?.environment || "dev";

  // Extract method and body from metadata if present
  const metadata = legacy.metadata || {};
  const method = (metadata as any).method;
  const body = (metadata as any).body;

  // Create redacted payload
  const data: AuditEventPayloadV1 = {
    method,
    body: body ? redactSensitiveData(body) as Record<string, unknown> : undefined,
    context: metadata,
  };

  return createAuditEvent(
    legacy.action,
    data,
    {
      actorIp: legacy.actorIp,
      resource: legacy.resource,
      status: legacy.status,
      service,
      environment,
    }
  );
}

/**
 * Helper function to validate ISO 8601 timestamp
 */
function isValidISO8601(timestamp: string): boolean {
  const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})?$/;
  return iso8601Regex.test(timestamp) && !isNaN(Date.parse(timestamp));
}

/**
 * Helper function to validate UUID v4
 */
function isValidUUID(uuid: string): boolean {
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidV4Regex.test(uuid);
}

/**
 * Helper function to validate IP address (basic check)
 */
function isValidIPAddress(ip: string): boolean {
  // IPv4 basic validation
  const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  // IPv6 basic validation (simplified)
  const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
  
  return ipv4Regex.test(ip) || ipv6Regex.test(ip) || ip === "::1";
}
