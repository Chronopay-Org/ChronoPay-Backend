import {
  getCurrentPolicy,
  getCurrentPolicyVersion,
  isFieldRedacted,
  getPolicyFields,
  swapPolicy,
  rollbackPolicy,
  getRollbackHistory,
  _resetPolicyForTesting,
} from "../../utils/redactionPolicy.js";
import { redact, wouldBeRedacted, getSensitiveFields } from "../../utils/redact.js";

beforeEach(() => {
  _resetPolicyForTesting();
});

describe("RedactionPolicy", () => {
  describe("default policy", () => {
    it("has version 1", () => {
      expect(getCurrentPolicyVersion()).toBe(1);
    });

    it("contains standard sensitive fields", () => {
      expect(isFieldRedacted("password")).toBe(true);
      expect(isFieldRedacted("token")).toBe(true);
      expect(isFieldRedacted("api_key")).toBe(true);
      expect(isFieldRedacted("authorization")).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(isFieldRedacted("PASSWORD")).toBe(true);
      expect(isFieldRedacted("Token")).toBe(true);
      expect(isFieldRedacted("API_KEY")).toBe(true);
    });

    it("returns false for non-sensitive fields", () => {
      expect(isFieldRedacted("email")).toBe(false);
      expect(isFieldRedacted("name")).toBe(false);
      expect(isFieldRedacted("userId")).toBe(false);
    });

    it("getPolicyFields returns the full list", () => {
      const fields = getPolicyFields();
      expect(fields.length).toBeGreaterThan(0);
      expect(fields).toContain("password");
      expect(fields).toContain("token");
    });
  });

  describe("swapPolicy", () => {
    it("upgrades version on successful swap", () => {
      const result = swapPolicy({ fields: ["secret", "key", "credential"] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.policy.version).toBe(2);
        expect(Array.from(result.policy.fields)).toEqual(
          expect.arrayContaining(["secret", "key", "credential"]),
        );
      }
    });

    it("rejects null input", () => {
      const result = swapPolicy(null);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("non-null object");
      }
    });

    it("rejects missing fields array", () => {
      const result = swapPolicy({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("fields' array");
      }
    });

    it("rejects empty fields array", () => {
      const result = swapPolicy({ fields: [] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("must not be empty");
      }
    });

    it("rejects non-string fields", () => {
      const result = swapPolicy({ fields: [123, true] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("must be strings");
      }
    });

    it("deduplicates fields", () => {
      const result = swapPolicy({ fields: ["password", "Password", "PASSWORD"] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.from(result.policy.fields)).toEqual(["password"]);
      }
    });

    it("trims and lowercases field names", () => {
      const result = swapPolicy({ fields: ["  Secret  ", "TOKEN "] });
      expect(result.success).toBe(true);
      if (result.success) {
        const fields = Array.from(result.policy.fields);
        expect(fields).toContain("secret");
        expect(fields).toContain("token");
      }
    });

    it("rejects fields longer than 128 chars", () => {
      const longField = "a".repeat(129);
      const result = swapPolicy({ fields: [longField] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("too long");
      }
    });

    it("rejects empty string fields after trim", () => {
      const result = swapPolicy({ fields: ["   "] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("empty strings");
      }
    });
  });

  describe("rollbackPolicy", () => {
    it("fails when no rollback entries exist", () => {
      const result = rollbackPolicy();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("No previous policy");
      }
    });

    it("restores previous version after swap", () => {
      swapPolicy({ fields: ["newfield1", "newfield2"] });
      expect(getCurrentPolicyVersion()).toBe(2);

      const rollback = rollbackPolicy();
      expect(rollback.success).toBe(true);
      expect(getCurrentPolicyVersion()).toBe(1);
    });

    it("tracks rollback history", () => {
      swapPolicy({ fields: ["field1"] });
      swapPolicy({ fields: ["field2"] });

      const history = getRollbackHistory();
      expect(history).toHaveLength(2);
      expect(history[0].version).toBe(2);
      expect(history[1].version).toBe(1);
    });

    it("limits rollback buffer to 5 entries", () => {
      for (let i = 0; i < 7; i++) {
        swapPolicy({ fields: [`field_${i}`] });
      }

      const history = getRollbackHistory();
      expect(history).toHaveLength(5);
    });
  });

  describe("hot-reload integration with redact()", () => {
    it("redact() uses the default policy", () => {
      const result = redact({ password: "mysecret", name: "John" }) as any;
      expect(result.password).toBe("my***et");
      expect(result.name).toBe("John");
    });

    it("redact() reflects new policy after swap", () => {
      swapPolicy({ fields: ["custom_secret", "internal_id"] });
      const result = redact({
        custom_secret: "sensitive-data",
        internal_id: "12345",
        name: "John",
      }) as any;

      expect(result.custom_secret).toBe("se***ta");
      expect(result.internal_id).toBe("12***45");
      expect(result.name).toBe("John");
    });

    it("no longer redacts old fields after swap", () => {
      swapPolicy({ fields: ["new_field"] });
      const result = redact({ password: "old-secret", new_field: "new-secret" }) as any;

      expect(result.password).toBe("old-secret");
      expect(result.new_field).toBe("ne***et");
    });

    it("restores old redaction after rollback", () => {
      swapPolicy({ fields: ["only_this"] });
      let result = redact({ password: "testpassword", only_this: "secretdata" }) as any;
      expect(result.password).toBe("testpassword");
      expect(result.only_this).toBe("se***ta");

      rollbackPolicy();
      result = redact({ password: "testpassword", only_this: "secretdata" }) as any;
      expect(result.password).toBe("te***rd");
      expect(result.only_this).toBe("secretdata");
    });

    it("wouldBeRedacted reflects policy changes", () => {
      expect(wouldBeRedacted("password")).toBe(true);
      expect(wouldBeRedacted("custom_field")).toBe(false);

      swapPolicy({ fields: ["custom_field"] });
      expect(wouldBeRedacted("password")).toBe(false);
      expect(wouldBeRedacted("custom_field")).toBe(true);
    });

    it("getSensitiveFields reflects policy changes", () => {
      const before = getSensitiveFields();
      expect(before).toContain("password");

      swapPolicy({ fields: ["brand_new_field"] });
      const after = getSensitiveFields();
      expect(after).toEqual(["brand_new_field"]);
    });
  });
});
