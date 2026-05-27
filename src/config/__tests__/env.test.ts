import { loadEnvConfig, EnvValidationError } from "../env";

/** Minimal valid env — all required fields present, all optional omitted. */
const VALID: NodeJS.ProcessEnv = {
  REDIS_URL: "redis://localhost:6379",
};

function load(overrides: NodeJS.ProcessEnv = {}) {
  return loadEnvConfig({ ...VALID, ...overrides });
}

function expectIssue(env: NodeJS.ProcessEnv, fragment: string) {
  try {
    loadEnvConfig(env);
    throw new Error("Expected EnvValidationError to be thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(EnvValidationError);
    const issues = (err as EnvValidationError).issues;
    expect(issues.some((i) => i.includes(fragment))).toBe(true);
  }
}

// ─── Defaults ────────────────────────────────────────────────────────────────

describe("defaults", () => {
  it("applies default NODE_ENV=development when omitted", () => {
    expect(load().nodeEnv).toBe("development");
  });

  it("applies default PORT=3001 when omitted", () => {
    expect(load().port).toBe(3001);
  });

  it("applies default rateLimitWindowMs=900000 when omitted", () => {
    expect(load().rateLimitWindowMs).toBe(900_000);
  });

  it("applies default rateLimitMax=100 when omitted", () => {
    expect(load().rateLimitMax).toBe(100);
  });

  it("applies default trustProxy=false when omitted", () => {
    expect(load().trustProxy).toBe(false);
  });
});

// ─── NODE_ENV ─────────────────────────────────────────────────────────────────

describe("NODE_ENV", () => {
  it.each(["development", "test", "production"] as const)("accepts %s", (val) => {
    expect(load({ NODE_ENV: val }).nodeEnv).toBe(val);
  });

  it("rejects unknown value 'staging'", () => {
    expectIssue({ ...VALID, NODE_ENV: "staging" }, "NODE_ENV");
  });

  it("rejects whitespace-only value", () => {
    expectIssue({ ...VALID, NODE_ENV: "   " }, "NODE_ENV");
  });

  it("does not echo the raw value in the error", () => {
    try {
      loadEnvConfig({ ...VALID, NODE_ENV: "staging" });
    } catch (err) {
      expect((err as EnvValidationError).message).not.toContain("staging");
    }
  });
});

// ─── PORT ─────────────────────────────────────────────────────────────────────

describe("PORT", () => {
  it("accepts valid port 8080", () => {
    expect(load({ PORT: "8080" }).port).toBe(8080);
  });

  it("accepts boundary port 1", () => {
    expect(load({ PORT: "1" }).port).toBe(1);
  });

  it("accepts boundary port 65535", () => {
    expect(load({ PORT: "65535" }).port).toBe(65535);
  });

  it("rejects PORT=0 (below minimum)", () => {
    expectIssue({ ...VALID, PORT: "0" }, "PORT");
  });

  it("rejects PORT=70000 (above maximum)", () => {
    expectIssue({ ...VALID, PORT: "70000" }, "PORT");
  });

  it("rejects non-integer PORT", () => {
    expectIssue({ ...VALID, PORT: "abc" }, "PORT");
  });

  it("rejects float PORT", () => {
    expectIssue({ ...VALID, PORT: "80.5" }, "PORT");
  });

  it("rejects whitespace-only PORT", () => {
    expectIssue({ ...VALID, PORT: "   " }, "PORT");
  });

  it("does not echo the raw value in the error", () => {
    try {
      loadEnvConfig({ ...VALID, PORT: "99999" });
    } catch (err) {
      expect((err as EnvValidationError).message).not.toContain("99999");
    }
  });
});

// ─── REDIS_URL ────────────────────────────────────────────────────────────────

describe("REDIS_URL", () => {
  it("accepts redis:// URL", () => {
    expect(load({ REDIS_URL: "redis://localhost:6379" }).redisUrl).toBe("redis://localhost:6379");
  });

  it("accepts rediss:// URL", () => {
    expect(load({ REDIS_URL: "rediss://cache.example.com:6380" }).redisUrl).toBe(
      "rediss://cache.example.com:6380",
    );
  });

  it("rejects missing REDIS_URL", () => {
    expectIssue({ NODE_ENV: "test" }, "REDIS_URL");
  });

  it("rejects whitespace-only REDIS_URL", () => {
    expectIssue({ ...VALID, REDIS_URL: "   " }, "REDIS_URL");
  });

  it("rejects http:// scheme", () => {
    expectIssue({ ...VALID, REDIS_URL: "http://localhost:6379" }, "REDIS_URL");
  });

  it("rejects embedded credentials", () => {
    expectIssue({ ...VALID, REDIS_URL: "redis://user:pass@localhost:6379" }, "REDIS_URL");
  });

  it("rejects invalid URL", () => {
    expectIssue({ ...VALID, REDIS_URL: "not-a-url" }, "REDIS_URL");
  });

  it("rejects URL with no hostname", () => {
    expectIssue({ ...VALID, REDIS_URL: "redis://" }, "REDIS_URL");
  });

  it("rejects URL containing internal whitespace", () => {
    expectIssue({ ...VALID, REDIS_URL: "redis://local host:6379" }, "REDIS_URL");
  });

  it("does not echo the raw value in the error", () => {
    const secret = "redis://user:s3cr3t@localhost:6379";
    try {
      loadEnvConfig({ ...VALID, REDIS_URL: secret });
    } catch (err) {
      expect((err as EnvValidationError).message).not.toContain("s3cr3t");
    }
  });
});

// ─── Aggregated errors ────────────────────────────────────────────────────────

describe("aggregated errors", () => {
  it("collects multiple issues in one throw", () => {
    try {
      loadEnvConfig({ NODE_ENV: "bad", PORT: "0", REDIS_URL: "   " });
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const issues = (err as EnvValidationError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(3);
      expect(issues.some((i) => i.includes("NODE_ENV"))).toBe(true);
      expect(issues.some((i) => i.includes("PORT"))).toBe(true);
      expect(issues.some((i) => i.includes("REDIS_URL"))).toBe(true);
    }
  });

  it("error message lists all issues with bullet prefix", () => {
    try {
      loadEnvConfig({ NODE_ENV: "bad", REDIS_URL: "   " });
    } catch (err) {
      expect((err as EnvValidationError).message).toMatch(/^Invalid environment configuration:/);
      expect((err as EnvValidationError).message).toContain("- ");
    }
  });
});

// ─── Optional fields ──────────────────────────────────────────────────────────

describe("optional fields", () => {
  it("returns undefined webhookSecret when omitted", () => {
    expect(load().webhookSecret).toBeUndefined();
  });

  it("returns trimmed webhookSecret when provided", () => {
    expect(load({ WEBHOOK_SECRET: "  mysecret  " }).webhookSecret).toBe("mysecret");
  });

  it("returns undefined for whitespace-only WEBHOOK_SECRET", () => {
    expect(load({ WEBHOOK_SECRET: "   " }).webhookSecret).toBeUndefined();
  });

  it("parses CORS_ALLOWED_ORIGINS as array", () => {
    expect(load({ CORS_ALLOWED_ORIGINS: "https://a.com,https://b.com" }).corsAllowedOrigins).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("returns empty array for omitted CORS_ALLOWED_ORIGINS", () => {
    expect(load().corsAllowedOrigins).toEqual([]);
  });

  it("accepts TRUST_PROXY=true", () => {
    expect(load({ TRUST_PROXY: "true" }).trustProxy).toBe(true);
  });

  it("accepts TRUST_PROXY=1", () => {
    expect(load({ TRUST_PROXY: "1" }).trustProxy).toBe(true);
  });

  it("rejects invalid TRUST_PROXY value", () => {
    expectIssue({ ...VALID, TRUST_PROXY: "yes" }, "TRUST_PROXY");
  });

  it("accepts valid RATE_LIMIT_WINDOW_MS", () => {
    expect(load({ RATE_LIMIT_WINDOW_MS: "60000" }).rateLimitWindowMs).toBe(60_000);
  });

  it("rejects RATE_LIMIT_WINDOW_MS=0", () => {
    expectIssue({ ...VALID, RATE_LIMIT_WINDOW_MS: "0" }, "RATE_LIMIT_WINDOW_MS");
  });

  it("accepts valid RATE_LIMIT_MAX", () => {
    expect(load({ RATE_LIMIT_MAX: "50" }).rateLimitMax).toBe(50);
  });

  it("rejects RATE_LIMIT_MAX=0", () => {
    expectIssue({ ...VALID, RATE_LIMIT_MAX: "0" }, "RATE_LIMIT_MAX");
  });
});

// ─── EnvValidationError shape ─────────────────────────────────────────────────

describe("EnvValidationError", () => {
  it("has name EnvValidationError", () => {
    try {
      loadEnvConfig({});
    } catch (err) {
      expect((err as EnvValidationError).name).toBe("EnvValidationError");
    }
  });

  it("exposes issues as a non-empty array", () => {
    try {
      loadEnvConfig({});
    } catch (err) {
      expect(Array.isArray((err as EnvValidationError).issues)).toBe(true);
      expect((err as EnvValidationError).issues.length).toBeGreaterThan(0);
    }
  });
});
