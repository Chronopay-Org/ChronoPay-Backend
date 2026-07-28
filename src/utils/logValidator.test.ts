// src/utils/logValidator.test.ts
import { validateLog, getLogValidatorErrors, validateLogEvent, getLogEventValidatorErrors } from "./logValidator";
import { getLogSchemaRegistry, collectLogSchemaDrift } from "./logSchemaRegistry";

describe("Log schema validation", () => {
  test("valid info log passes", () => {
    const log = {
      level: "info",
      msg: "request processed",
      requestId: "req-123",
      route: "/api/v1/pay",
      latencyMs: 45.6,
    };
    expect(validateLog(log)).toBe(true);
    expect(getLogValidatorErrors()).toBeNull();
  });

  test("error log requires errCode", () => {
    const log = {
      level: "error",
      msg: "database failure",
      requestId: "req-456",
      route: "/api/v1/pay",
      latencyMs: 12,
    };
    expect(validateLog(log)).toBe(false);
    const errors = getLogValidatorErrors();
    expect(errors).not.toBeNull();
    const err = errors?.find((e: any) => e.keyword === "required" && e.params?.missingProperty === "errCode");
    expect(err).toBeDefined();
  });

  test("event-specific validation checks required fields per schema", () => {
    const validLog = {
      level: "info",
      msg: "database query completed",
      db_operation: true,
      operation: "SELECT",
      table: "orders",
      duration_ms: 12,
    };

    expect(validateLogEvent("db_operation", validLog)).toBe(true);
    expect(getLogEventValidatorErrors("db_operation")).toBeNull();

    const invalidLog = {
      level: "info",
      msg: "database query completed",
      db_operation: true,
      operation: "SELECT",
    };

    expect(validateLogEvent("db_operation", invalidLog)).toBe(false);
    const dbErrors = getLogEventValidatorErrors("db_operation");
    expect(dbErrors).not.toBeNull();
    expect(dbErrors?.some((error: any) => error.params?.missingProperty === "table")).toBe(true);
  });

  test("schema registry exposes documented event definitions", () => {
    const registry = getLogSchemaRegistry();
    expect(registry).toEqual(expect.objectContaining({
      http_request: expect.any(Object),
      db_operation: expect.any(Object),
      external_call: expect.any(Object),
      security_event: expect.any(Object),
    }));

    const drift = collectLogSchemaDrift();
    expect(drift).toEqual([]);
  });
});
