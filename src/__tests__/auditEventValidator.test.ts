import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  redactSensitiveData,
  isSensitiveField,
  validateEnvelope,
  validatePayloadV1,
  validateAuditEvent,
  createAuditEvent,
  encodeAuditEvent,
  decodeAuditEvent,
  migrateLegacyEntry,
  AuditEventValidationError,
  AuditEventVersionError,
  AUDIT_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
} from "../utils/auditEventValidator.js";

describe("auditEventValidator", () => {
  describe("redactSensitiveData", () => {
    it("should redact password fields", () => {
      const data = { username: "test", password: "secret123" };
      const result = redactSensitiveData(data);
      expect(result).toEqual({ username: "test", password: "***REDACTED***" });
    });

    it("should redact token fields", () => {
      const data = { userId: "123", api_key: "secret_key" };
      const result = redactSensitiveData(data);
      expect(result).toEqual({ userId: "123", api_key: "***REDACTED***" });
    });

    it("should redact authorization header", () => {
      const data = { authorization: "Bearer token123" };
      const result = redactSensitiveData(data);
      expect(result).toEqual({ authorization: "***REDACTED***" });
    });

    it("should redact nested sensitive fields", () => {
      const data = { user: { name: "test", password: "secret" } };
      const result = redactSensitiveData(data);
      expect(result).toEqual({ user: { name: "test", password: "***REDACTED***" } });
    });

    it("should redact sensitive fields in arrays", () => {
      const data = [{ password: "secret1" }, { password: "secret2" }];
      const result = redactSensitiveData(data);
      expect(result).toEqual([{ password: "***REDACTED***" }, { password: "***REDACTED***" }]);
    });

    it("should redact long strings (>256 chars)", () => {
      const longString = "a".repeat(300);
      const data = { short: "abc", long: longString };
      const result = redactSensitiveData(data);
      expect(result).toEqual({ short: "abc", long: "***REDACTED***" });
    });

    it("should not redact allowed fields", () => {
      const data = { id: "123", name: "test", email: "test@example.com" };
      const result = redactSensitiveData(data);
      expect(result).toEqual(data);
    });

    it("should handle null and undefined", () => {
      expect(redactSensitiveData(null)).toBe(null);
      expect(redactSensitiveData(undefined)).toBe(undefined);
    });

    it("should handle primitives", () => {
      expect(redactSensitiveData("string")).toBe("string");
      expect(redactSensitiveData(123)).toBe(123);
      expect(redactSensitiveData(true)).toBe(true);
    });

    it("should redact unknown types for safety", () => {
      const func = () => {};
      const result = redactSensitiveData(func);
      expect(result).toBe("***REDACTED***");
    });
  });

  describe("isSensitiveField", () => {
    it("should identify password as sensitive", () => {
      expect(isSensitiveField("password")).toBe(true);
      expect(isSensitiveField("PASSWORD")).toBe(true);
    });

    it("should identify token as sensitive", () => {
      expect(isSensitiveField("token")).toBe(true);
      expect(isSensitiveField("api_key")).toBe(true);
      expect(isSensitiveField("apiKey")).toBe(true);
    });

    it("should not identify allowed fields as sensitive", () => {
      expect(isSensitiveField("id")).toBe(false);
      expect(isSensitiveField("name")).toBe(false);
      expect(isSensitiveField("email")).toBe(false);
    });
  });

  describe("validateEnvelope", () => {
    it("should validate a correct envelope", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST_ACTION",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).not.toThrow();
    });

    it("should throw if version is missing", () => {
      const envelope = {
        timestamp: new Date().toISOString(),
        eventId: "123e4567-e89b-12d3-a456-426614174000",
        action: "TEST_ACTION",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
    });

    it("should throw if timestamp is invalid", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: "invalid",
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST_ACTION",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).toThrow(AuditEventValidationError);
    });

    it("should throw if eventId is not a valid UUID", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "not-a-uuid",
        action: "TEST_ACTION",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).toThrow(AuditEventValidationError);
    });

    it("should throw if eventId is not UUID v4", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "123e4567-e89b-12d3-a456-426614174000", // This is not v4 (version digit is not 4)
        action: "TEST_ACTION",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).toThrow(AuditEventValidationError);
    });

    it("should throw if action exceeds 256 characters", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "123e4567-e89b-12d3-a456-426614174000",
        action: "a".repeat(257),
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).toThrow(AuditEventValidationError);
    });

    it("should throw if actorIp is invalid", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "123e4567-e89b-12d3-a456-426614174000",
        action: "TEST_ACTION",
        actorIp: "not-an-ip",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).toThrow(AuditEventValidationError);
    });

    it("should throw if resource exceeds 2048 characters", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "123e4567-e89b-12d3-a456-426614174000",
        action: "TEST_ACTION",
        resource: "a".repeat(2049),
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).toThrow(AuditEventValidationError);
    });

    it("should throw if status is missing", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "123e4567-e89b-12d3-a456-426614174000",
        action: "TEST_ACTION",
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
    });

    it("should throw if environment is invalid", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "123e4567-e89b-12d3-a456-426614174000",
        action: "TEST_ACTION",
        status: 200,
        data: {},
        service: "test-service",
        environment: "invalid",
      };
      expect(() => validateEnvelope(envelope)).toThrow(AuditEventValidationError);
    });
  });

  describe("validatePayloadV1", () => {
    it("should validate a correct v1 payload", () => {
      const payload = {
        method: "POST",
        body: { name: "test" },
        userId: "user123",
      };
      expect(() => validatePayloadV1(payload)).not.toThrow();
    });

    it("should throw if method is invalid", () => {
      const payload = { method: "INVALID" };
      expect(() => validatePayloadV1(payload)).toThrow(AuditEventValidationError);
    });

    it("should throw if body is not an object", () => {
      const payload = { body: "not-an-object" as any };
      expect(() => validatePayloadV1(payload)).toThrow(AuditEventValidationError);
    });

    it("should throw if context is not an object", () => {
      const payload = { context: "not-an-object" as any };
      expect(() => validatePayloadV1(payload)).toThrow(AuditEventValidationError);
    });
  });

  describe("validateAuditEvent", () => {
    it("should validate a complete v1.0.0 event", () => {
      const event = createAuditEvent("TEST_ACTION", { method: "POST" }, { status: 200 });
      expect(() => validateAuditEvent(event)).not.toThrow();
    });

    it("should throw for unsupported version", () => {
      const event = {
        version: "99.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateAuditEvent(event as any)).toThrow(AuditEventVersionError);
    });

  });

  describe("createAuditEvent", () => {
    it("should create a valid audit event", () => {
      const event = createAuditEvent("CREATE_USER", { userId: "123" }, {
        actorIp: "127.0.0.1",
        resource: "/api/users",
        status: 201,
      });

      expect(event.version).toBe(AUDIT_SCHEMA_VERSION);
      expect(event.action).toBe("CREATE_USER");
      expect(event.actorIp).toBe("127.0.0.1");
      expect(event.resource).toBe("/api/users");
      expect(event.status).toBe(201);
      expect(event.service).toBe("chronopay-backend");
      expect(event.environment).toBe("dev");
      expect(event.eventId).toBeDefined();
      expect(event.timestamp).toBeDefined();
    });

    it("should redact sensitive data in payload", () => {
      const event = createAuditEvent("LOGIN", { 
        method: "POST",
        body: { username: "test", password: "secret" }
      }, { status: 200 });

      expect(event.data.body?.password).toBe("***REDACTED***");
      expect(event.data.body?.username).toBe("test");
    });

    it("should use provided service and environment", () => {
      const event = createAuditEvent("TEST", {}, {
        service: "custom-service",
        environment: "prod",
        status: 200,
      });

      expect(event.service).toBe("custom-service");
      expect(event.environment).toBe("prod");
    });
  });

  describe("encodeAuditEvent", () => {
    it("should encode event to JSON string", () => {
      const event = createAuditEvent("TEST", {}, { status: 200 });
      const encoded = encodeAuditEvent(event);
      expect(typeof encoded).toBe("string");
      const decoded = JSON.parse(encoded);
      expect(decoded.version).toBe(AUDIT_SCHEMA_VERSION);
    });

    it("should throw for invalid event", () => {
      const invalidEvent = { version: "invalid" } as any;
      expect(() => encodeAuditEvent(invalidEvent)).toThrow();
    });
  });

  describe("decodeAuditEvent", () => {
    it("should decode valid JSON to event", () => {
      const event = createAuditEvent("TEST", {}, { status: 200 });
      const encoded = encodeAuditEvent(event);
      const decoded = decodeAuditEvent(encoded);
      expect(decoded.action).toBe(event.action);
      expect(decoded.version).toBe(event.version);
    });

    it("should throw for invalid JSON", () => {
      expect(() => decodeAuditEvent("not json")).toThrow(AuditEventValidationError);
    });

    it("should throw for invalid event structure", () => {
      const invalidJson = JSON.stringify({ version: "1.0.0" }); // Missing required fields
      expect(() => decodeAuditEvent(invalidJson)).toThrow(AuditEventValidationError);
    });
  });

  describe("migrateLegacyEntry", () => {
    it("should migrate legacy entry to versioned format", () => {
      const legacy = {
        timestamp: "2024-01-01T00:00:00.000Z",
        action: "LEGACY_ACTION",
        actorIp: "192.168.1.1",
        resource: "/api/legacy",
        status: 200,
        metadata: {
          method: "POST",
          body: { username: "test", password: "secret" },
        },
      };

      const migrated = migrateLegacyEntry(legacy);

      expect(migrated.version).toBe(AUDIT_SCHEMA_VERSION);
      expect(migrated.action).toBe("LEGACY_ACTION");
      expect(migrated.actorIp).toBe("192.168.1.1");
      expect(migrated.data.body?.password).toBe("***REDACTED***");
      expect(migrated.data.method).toBe("POST");
    });

    it("should handle legacy entry without metadata", () => {
      const legacy = {
        timestamp: "2024-01-01T00:00:00.000Z",
        action: "LEGACY_ACTION",
        status: 200,
      };

      const migrated = migrateLegacyEntry(legacy);
      expect(migrated.version).toBe(AUDIT_SCHEMA_VERSION);
      expect(migrated.action).toBe("LEGACY_ACTION");
    });

    it("should use provided service and environment", () => {
      const legacy = {
        timestamp: "2024-01-01T00:00:00.000Z",
        action: "TEST",
        status: 200,
      };

      const migrated = migrateLegacyEntry(legacy, {
        service: "legacy-service",
        environment: "staging",
      });

      expect(migrated.service).toBe("legacy-service");
      expect(migrated.environment).toBe("staging");
    });
  });

  describe("Security Validation", () => {
    it("should prevent injection via action field", () => {
      const maliciousAction = 'TEST"; DROP TABLE users; --';
      const event = createAuditEvent(maliciousAction, {}, { status: 200 });
      expect(event.action).toBe(maliciousAction);
      // The action is validated for length but content is preserved for audit trail
    });

    it("should redact all known sensitive fields", () => {
      const sensitiveData = {
        password: "pwd",
        passwd: "pwd",
        secret: "sec",
        token: "tok",
        api_key: "key",
        authorization: "auth",
        credit_card: "4111",
        ssn: "123-45-6789",
        pin: "1234",
      };

      const event = createAuditEvent("TEST", { body: sensitiveData }, { status: 200 });
      const redacted = event.data.body as any;

      Object.values(redacted).forEach((value) => {
        expect(value).toBe("***REDACTED***");
      });
    });
  });
});
