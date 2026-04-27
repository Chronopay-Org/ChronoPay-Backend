import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import process from "node:process";
import app from "../index.js";
import { ConfigService, ConfigError, configService as singletonInstance } from "../config/config.service.js";

describe.skip("ConfigService Secret Rotation", () => {
  let testConfigService: ConfigService;

  beforeEach(() => {
    // Reset process.env for each test
    process.env.JWT_SECRET = "primary-secret";
    process.env.JWT_SECRET_PREV = "previous-secret";
    
    // Refresh the singleton instance used by the app for each test
    singletonInstance.refresh();
    
    // Create a dedicated instance for unit testing
    // @ts-ignore
    ConfigService.instance = undefined;
    testConfigService = ConfigService.getInstance();
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
    delete process.env.JWT_SECRET_PREV;
    delete process.env.API_KEY;
  });

  it("should load primary and previous secret versions correctly", () => {
    const primary = testConfigService.getSecret("JWT_SECRET");
    const allVersions = testConfigService.getAllSecretVersions("JWT_SECRET");

    expect(primary).toBe("primary-secret");
    expect(allVersions).toContain("primary-secret");
    expect(allVersions).toContain("previous-secret");
    expect(allVersions.length).toBe(2);
  });

  it("should throw ConfigError if secret is missing", () => {
    expect(() => {
      testConfigService.getSecret("MISSING_SECRET");
    }).toThrow(ConfigError);
  });

  it("should return only primary if no previous version exists", () => {
    delete process.env.JWT_SECRET_PREV;
    testConfigService.refresh();
    
    const allVersions = testConfigService.getAllSecretVersions("JWT_SECRET");
    expect(allVersions).toEqual(["primary-secret"]);
  });

  it("should handle dynamic refreshes correctly", () => {
    process.env.JWT_SECRET = "new-primary-secret";
    process.env.JWT_SECRET_PREV = "old-primary-secret";
    testConfigService.refresh();

    expect(testConfigService.getSecret("JWT_SECRET")).toBe("new-primary-secret");
    expect(testConfigService.getAllSecretVersions("JWT_SECRET")).toEqual([
      "new-primary-secret",
      "old-primary-secret"
    ]);
  });

  describe("API Authentication with Rotation", () => {
    it("should accept token signed with primary secret", async () => {
      const res = await request(app)
        .post("/api/v1/auth/verify")
        .send({ token: "valid-token-for-primary-secret" });
      
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("should accept token signed with previous secret during rotation", async () => {
      const res = await request(app)
        .post("/api/v1/auth/verify")
        .send({ token: "valid-token-for-previous-secret" });
      
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("should reject token signed with unknown secret", async () => {
      const res = await request(app)
        .post("/api/v1/auth/verify")
        .send({ token: "invalid-token" });
      
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("should reject previous secret once rotation is complete (cleanup phase)", async () => {
      // Phase 4: Cleanup - remove previous secret
      delete process.env.JWT_SECRET_PREV;
      singletonInstance.refresh();

      const res = await request(app)
        .post("/api/v1/auth/verify")
        .send({ token: "valid-token-for-previous-secret" });
      
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });
});
