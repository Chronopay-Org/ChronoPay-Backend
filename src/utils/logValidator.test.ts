// src/utils/logValidator.test.ts
import { validateLog, getLogValidatorErrors } from "./logValidator";

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
    // Ensure the missing errCode is reported
    const err = errors?.find((e: any) => e.keyword === "required" && e.params?.missingProperty === "errCode");
    expect(err).toBeDefined();
  });
});
