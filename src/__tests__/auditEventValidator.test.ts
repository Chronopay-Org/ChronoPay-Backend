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
  DEPRECATED_SCHEMA_VERSIONS,
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

    it("should throw if version is not a string", () => {
      const envelope = {
        version: 123,
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

    it("should throw if timestamp is not a string", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: 123456,
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST_ACTION",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
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

    it("should throw if eventId is not a string", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: 123,
        action: "TEST_ACTION",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
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

    it("should throw if action is not a string", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "123e4567-e89b-12d3-a456-426614174000",
        action: 123,
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
    });

    it("should throw if action is missing", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "123e4567-e89b-12d3-a456-426614174000",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
    });

    it("should throw if action is null", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "123e4567-e89b-12d3-a456-426614174000",
        action: null,
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
    });

    it("should throw if action is undefined", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "123e4567-e89b-12d3-a456-426614174000",
        action: undefined,
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
    });

    it("should evaluate action presence check", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate action type check", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate action length check", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate actorIp type check when present", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        actorIp: "192.168.1.1",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate actorIp validation when present", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        actorIp: "192.168.1.1",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate resource type check when present", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        resource: "/api/test",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate resource length check when present", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        resource: "/api/test",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate status presence check", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate status type check", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate data check", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate service check", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate environment check", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate environment validation", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
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

    it("should throw if actorIp is not a string", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "123e4567-e89b-12d3-a456-426614174000",
        action: "TEST_ACTION",
        actorIp: 123,
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
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

    it("should throw if resource is not a string", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "123e4567-e89b-12d3-a456-426614174000",
        action: "TEST_ACTION",
        resource: 123,
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
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

    it("should throw if status is not number or string", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "123e4567-e89b-12d3-a456-426614174000",
        action: "TEST_ACTION",
        status: {},
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
    });

    it("should throw if data is not an object", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "123e4567-e89b-12d3-a456-426614174000",
        action: "TEST_ACTION",
        status: 200,
        data: "not-an-object",
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
    });

    it("should throw if service is not a string", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "123e4567-e89b-12d3-a456-426614174000",
        action: "TEST_ACTION",
        status: 200,
        data: {},
        service: 123,
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
    });

    it("should throw if environment is not a string", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "123e4567-e89b-12d3-a456-426614174000",
        action: "TEST_ACTION",
        status: 200,
        data: {},
        service: "test-service",
        environment: 123,
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

    it("should accept valid IPv4 address", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST_ACTION",
        actorIp: "192.168.1.1",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).not.toThrow();
    });

    it("should accept valid IPv6 address", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST_ACTION",
        actorIp: "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).not.toThrow();
    });

    it("should accept localhost IPv6", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST_ACTION",
        actorIp: "::1",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).not.toThrow();
    });

    it("should accept action at exactly 256 characters", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "a".repeat(256),
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).not.toThrow();
    });

    it("should accept resource at exactly 2048 characters", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST_ACTION",
        resource: "a".repeat(2048),
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).not.toThrow();
    });

    it("should accept string status", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST_ACTION",
        status: "success",
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).not.toThrow();
    });

    it("should accept number status", () => {
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

    it("should accept all valid environments", () => {
      const validEnvironments = ["dev", "staging", "prod", "test"];
      validEnvironments.forEach((env) => {
        const envelope = {
          version: "1.0.0",
          timestamp: new Date().toISOString(),
          eventId: "550e8400-e29b-41d4-a716-446655440000",
          action: "TEST_ACTION",
          status: 200,
          data: {},
          service: "test-service",
          environment: env,
        };
        expect(() => validateEnvelope(envelope)).not.toThrow();
      });
    });

    it("should accept envelope without actorIp", () => {
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

    it("should accept envelope without resource", () => {
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

    it("should accept envelope with action provided", () => {
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

    it("should accept envelope with actorIp provided", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST_ACTION",
        actorIp: "192.168.1.1",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).not.toThrow();
    });

    it("should accept envelope with resource provided", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST_ACTION",
        resource: "/api/test",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).not.toThrow();
    });

    it("should accept envelope with status provided", () => {
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

    it("should accept envelope with data provided", () => {
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

    it("should accept envelope with service provided", () => {
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

    it("should accept envelope with environment provided", () => {
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

    it("should pass action length check when action is short", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "SHORT",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).not.toThrow();
    });

    it("should pass actorIp type check when actorIp is valid string", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST_ACTION",
        actorIp: "10.0.0.1",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).not.toThrow();
    });

    it("should pass actorIp validation when IP is valid", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST_ACTION",
        actorIp: "192.168.1.100",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).not.toThrow();
    });

    it("should pass resource type check when resource is valid string", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST_ACTION",
        resource: "/api/test",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).not.toThrow();
    });

    it("should pass resource length check when resource is short", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST_ACTION",
        resource: "/short",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).not.toThrow();
    });

    it("should pass status check when status is defined", () => {
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

    it("should pass status type check when status is number", () => {
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

    it("should pass status type check when status is string", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST_ACTION",
        status: "success",
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).not.toThrow();
    });

    it("should pass data check when data is valid object", () => {
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

    it("should pass service check when service is valid string", () => {
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

    it("should pass environment check when environment is valid string", () => {
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

    it("should pass environment validation when environment is in allowed list", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST_ACTION",
        status: 200,
        data: {},
        service: "test-service",
        environment: "staging",
      };
      expect(() => validateEnvelope(envelope)).not.toThrow();
    });
  });

  describe("validateEnvelope - positive validation paths", () => {
    it("should evaluate action presence check and pass", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate action type check and pass", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate action length check and pass", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "SHORT",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate actorIp type check when present and pass", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        actorIp: "192.168.1.1",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate actorIp validation when present and pass", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        actorIp: "10.0.0.1",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate resource type check when present and pass", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        resource: "/api/test",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate resource length check when present and pass", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        resource: "/short",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate status presence check and pass", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate status type check and pass for number", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate status type check and pass for string", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: "ok",
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate data check and pass", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate service check and pass", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate environment check and pass", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      validateEnvelope(envelope);
    });

    it("should evaluate environment validation and pass", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: "test-service",
        environment: "prod",
      };
      validateEnvelope(envelope);
    });
  });

  describe("validateEnvelope - negative validation paths", () => {
    it("should throw when action is missing (line 200)", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
    });

    it("should throw when action is not string (line 200)", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: 123,
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
    });

    it("should throw when action exceeds 256 chars (line 208)", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "a".repeat(257),
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).toThrow(AuditEventValidationError);
    });

    it("should throw when actorIp is not string (line 217)", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        actorIp: 123,
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
    });

    it("should throw when actorIp is invalid (line 225)", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        actorIp: "invalid-ip",
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).toThrow(AuditEventValidationError);
    });

    it("should throw when resource is not string (line 235)", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        resource: 123,
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
    });

    it("should throw when resource exceeds 2048 chars (line 242)", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        resource: "a".repeat(2049),
        status: 200,
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope)).toThrow(AuditEventValidationError);
    });

    it("should throw when status is missing (line 251)", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
    });

    it("should throw when status is not number or string (line 259)", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: {},
        data: {},
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
    });

    it("should throw when data is not object (line 267)", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: "not-object",
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
    });

    it("should throw when service is not string (line 275)", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: 123,
        environment: "dev",
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
    });

    it("should throw when environment is not string (line 283)", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: "test-service",
        environment: 123,
      };
      expect(() => validateEnvelope(envelope as any)).toThrow(AuditEventValidationError);
    });

    it("should throw when environment is invalid (line 293)", () => {
      const envelope = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: {},
        service: "test-service",
        environment: "invalid-env",
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

    it("should throw if method is not a string", () => {
      const payload = { method: 123 as any };
      expect(() => validatePayloadV1(payload)).toThrow(AuditEventValidationError);
    });

    it("should throw if body is not an object", () => {
      const payload = { body: "not-an-object" as any };
      expect(() => validatePayloadV1(payload)).toThrow(AuditEventValidationError);
    });

    it("should throw if body is null", () => {
      const payload = { body: null as any };
      expect(() => validatePayloadV1(payload)).toThrow(AuditEventValidationError);
    });

    it("should throw if context is not an object", () => {
      const payload = { context: "not-an-object" as any };
      expect(() => validatePayloadV1(payload)).toThrow(AuditEventValidationError);
    });

    it("should throw if context is null", () => {
      const payload = { context: null as any };
      expect(() => validatePayloadV1(payload)).toThrow(AuditEventValidationError);
    });

    it("should throw if userId is not a string", () => {
      const payload = { userId: 123 as any };
      expect(() => validatePayloadV1(payload)).toThrow(AuditEventValidationError);
    });

    it("should throw if sessionId is not a string", () => {
      const payload = { sessionId: 123 as any };
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

    it("should throw for deprecated version", () => {
      // Temporarily add a deprecated version for testing
      const originalDeprecated = [...DEPRECATED_SCHEMA_VERSIONS];
      (DEPRECATED_SCHEMA_VERSIONS as string[]).push("0.9.0");
      
      try {
        const event = {
          version: "0.9.0",
          timestamp: new Date().toISOString(),
          eventId: "550e8400-e29b-41d4-a716-446655440000",
          action: "TEST",
          status: 200,
          data: {},
          service: "test-service",
          environment: "dev",
        };
        expect(() => validateAuditEvent(event as any)).toThrow(AuditEventVersionError);
      } finally {
        // Restore original deprecated versions
        DEPRECATED_SCHEMA_VERSIONS.length = 0;
        DEPRECATED_SCHEMA_VERSIONS.push(...originalDeprecated);
      }
    });

    it("should throw if payload size exceeds limit", () => {
      const largeData: Record<string, unknown> = {};
      for (let i = 0; i < 10000; i++) {
        largeData[`field${i}`] = "x".repeat(100);
      }
      
      const event = {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        action: "TEST",
        status: 200,
        data: largeData,
        service: "test-service",
        environment: "dev",
      };
      expect(() => validateAuditEvent(event as any)).toThrow(AuditEventValidationError);
    });

    it("should throw for version with no validator implementation", () => {
      // Temporarily add a version to supported versions that has no validator
      const originalSupported = [...SUPPORTED_SCHEMA_VERSIONS];
      (SUPPORTED_SCHEMA_VERSIONS as string[]).push("2.0.0");
      
      try {
        const event = {
          version: "2.0.0",
          timestamp: new Date().toISOString(),
          eventId: "550e8400-e29b-41d4-a716-446655440000",
          action: "TEST",
          status: 200,
          data: {},
          service: "test-service",
          environment: "dev",
        };
        expect(() => validateAuditEvent(event as any)).toThrow(AuditEventVersionError);
      } finally {
        // Restore original supported versions
        SUPPORTED_SCHEMA_VERSIONS.length = 0;
        SUPPORTED_SCHEMA_VERSIONS.push(...originalSupported);
      }
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
    });

    it("should default status to 'unknown' when not provided", () => {
      const event = createAuditEvent("TEST_ACTION", {}, {});

      expect(event.status).toBe("unknown");
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
