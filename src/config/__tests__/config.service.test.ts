/**
 * Focused behavior coverage for `src/config/config.service.ts`.
 *
 * `ConfigService` is a private-constructor singleton that reads `process.env`
 * once through `loadEnvConfig()` and then hydrates an in-memory secret map
 * asynchronously from a `SecretsProvider`. Because the module also eagerly
 * exports `configService` (constructed at import time), every case here resets
 * the module registry, seeds the environment and imports the module fresh —
 * the pattern already used by `jwt.test.ts` / `secretsProvider.test.ts`.
 *
 * The secrets provider is replaced with a deterministic double so rotation,
 * provider failures and boundary version shapes are observable without
 * depending on the real env-backed provider. Each load sweep is awaited by
 * watching the provider call count and then draining the microtask queue,
 * which keeps the async assertions free of arbitrary sleeps.
 */

import { describe, it, expect, jest, afterEach } from "@jest/globals";
import EventEmitter from "node:events";

type ConfigModule = typeof import("../config.service.js");
type EnvModule = typeof import("../env.js");
type SecretVersions = import("../config.service.js").SecretVersions;
type ConfigServiceInstance = ConfigModule["configService"];

/** Keys read by `loadEnvConfig` plus the provider TTL knob owned by this module. */
const MANAGED_ENV_KEYS = [
  "NODE_ENV",
  "PORT",
  "REDIS_URL",
  "REQUEST_TIMEOUT_MS",
  "RATE_LIMIT_WINDOW_MS",
  "RATE_LIMIT_MAX",
  "TRUST_PROXY",
  "WEBHOOK_SECRET",
  "JWT_ISSUER",
  "JWT_AUDIENCE",
  "CORS_ALLOWED_ORIGINS",
  "HORIZON_URL",
  "HORIZON_URLS",
  "STELLAR_NETWORK_PASSPHRASE",
  "ESCROW_CONTRACT_HASH",
  "INTERNAL_OVERRIDE_SECRET",
  "INTERNAL_OVERRIDE_SECRET_PREV",
  "INTERNAL_BYPASS_TOLERANCE_MS",
  "MFA_ISSUER",
  "MFA_FRESHNESS_MS",
  "MFA_WINDOW_PERIODS",
  "MFA_CHALLENGE_TTL_SEC",
  "SECRET_CACHE_TTL_SECONDS",
] as const;

/**
 * Minimal env that satisfies `loadEnvConfig`. Every other managed key — including
 * NODE_ENV — is unset so that the documented defaults stay reachable.
 */
const BASE_ENV: NodeJS.ProcessEnv = {
  REDIS_URL: "redis://localhost:6379",
};

/** The fixed set of secret keys `ConfigService` reads on every load sweep. */
const SWEPT_SECRET_KEYS = [
  "JWT_SECRET",
  "API_KEY",
  "STELLAR_SECRET_KEY",
  "WEBHOOK_SECRET",
  "MFA_ENCRYPTION_KEY",
  "MFA_CHALLENGE_SECRET",
] as const;

const savedEnv = new Map<string, string | undefined>(
  MANAGED_ENV_KEYS.map((key) => [key, process.env[key]] as const),
);

// ─── Deterministic secrets provider double ───────────────────────────────────

class FakeSecretsProvider extends EventEmitter {
  public readonly options: unknown;
  public readonly requestedKeys: string[] = [];

  private readonly versions = new Map<string, string[]>();
  private readonly failures = new Map<string, Error>();

  constructor(options?: unknown) {
    super();
    this.options = options;
  }

  setVersions(key: string, versions: readonly string[]): void {
    this.versions.set(key, [...versions]);
    this.failures.delete(key);
  }

  setFailure(key: string, message: string): void {
    this.failures.set(key, new Error(message));
  }

  async getAllVersions(key: string): Promise<string[]> {
    this.requestedKeys.push(key);
    const failure = this.failures.get(key);
    if (failure) throw failure;
    return [...(this.versions.get(key) ?? [])];
  }

  async getSecret(key: string): Promise<string> {
    const versions = await this.getAllVersions(key);
    if (versions.length === 0) throw new Error(`Secret not found in provider: ${key}`);
    return versions[0];
  }

  rotate(key?: string): void {
    this.emit("rotate", key);
  }
}

const createdProviders: FakeSecretsProvider[] = [];

interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  /** key -> ordered versions handed back by the provider. */
  secrets?: ReadonlyArray<readonly [string, readonly string[]]>;
  /** key -> provider error raised instead of returning versions. */
  failures?: ReadonlyArray<readonly [string, string]>;
}

function applyPlan(provider: FakeSecretsProvider, options: LoadOptions): void {
  for (const [key, versions] of options.secrets ?? []) provider.setVersions(key, versions);
  for (const [key, message] of options.failures ?? []) provider.setFailure(key, message);
}

/**
 * Registered immediately before each dynamic import so the mock applies to the
 * current module-registry generation.
 */
function registerSecretsProviderMock(plan: LoadOptions): void {
  jest.unstable_mockModule("../../services/secrets/index.js", () => ({
    createSecretsProviderFromEnv: (options?: unknown) => {
      const provider = new FakeSecretsProvider(options);
      applyPlan(provider, plan);
      createdProviders.push(provider);
      return provider;
    },
  }));
}

// ─── Environment / module helpers ────────────────────────────────────────────

function seedEnv(overrides: NodeJS.ProcessEnv = {}): void {
  for (const key of MANAGED_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, BASE_ENV, overrides);
}

/** Resets state and re-arms the provider mock without importing the module. */
function prepare(options: LoadOptions): void {
  jest.resetModules();
  createdProviders.length = 0;
  seedEnv(options.env);
  registerSecretsProviderMock(options);
}

interface LoadedConfigService {
  module: ConfigModule;
  env: EnvModule;
  service: ConfigServiceInstance;
  provider: FakeSecretsProvider;
}

async function loadConfigService(options: LoadOptions = {}): Promise<LoadedConfigService> {
  prepare(options);

  const env = await import("../env.js");
  const module = await import("../config.service.js");
  const provider = createdProviders[0];
  if (!provider) throw new Error("expected ConfigService to construct a secrets provider");

  return { module, env, service: module.configService, provider };
}

async function waitFor(condition: () => boolean, description: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Waits until `count` full sweeps have been requested, then drains the
 * microtask queue so the last `await` inside the sweep has settled.
 */
async function completeSweeps(provider: FakeSecretsProvider, count: number): Promise<void> {
  await waitFor(
    () => provider.requestedKeys.length >= count * SWEPT_SECRET_KEYS.length,
    `${count} provider sweep(s) to finish`,
  );
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitForInitialLoad(loaded: LoadedConfigService): Promise<void> {
  await completeSweeps(loaded.provider, 1);
}

afterEach(() => {
  for (const key of MANAGED_ENV_KEYS) {
    const original = savedEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  createdProviders.length = 0;
  jest.resetModules();
});

// ─── ConfigError ─────────────────────────────────────────────────────────────

describe("ConfigError", () => {
  it("is a subclass of Error", async () => {
    const { module } = await loadConfigService();

    expect(new module.ConfigError("boom")).toBeInstanceOf(Error);
  });

  it("sets name to ConfigError", async () => {
    const { module } = await loadConfigService();

    expect(new module.ConfigError("boom").name).toBe("ConfigError");
  });

  it("prefixes the message with the [ConfigService] marker", async () => {
    const { module } = await loadConfigService();

    expect(new module.ConfigError("boom").message).toBe("[ConfigService] boom");
  });

  it("keeps the marker for an empty message", async () => {
    const { module } = await loadConfigService();

    expect(new module.ConfigError("").message).toBe("[ConfigService] ");
  });

  it("does not rewrite the caller-supplied message body", async () => {
    const { module } = await loadConfigService();

    expect(new module.ConfigError("Secret not found: API_KEY").message).toBe(
      "[ConfigService] Secret not found: API_KEY",
    );
  });
});

// ─── SecretVersions ──────────────────────────────────────────────────────────

describe("SecretVersions", () => {
  it("keeps only the primary version when the provider exposes one", async () => {
    const loaded = await loadConfigService({ secrets: [["JWT_SECRET", ["jwt-v1"]]] });
    await waitForInitialLoad(loaded);

    expect(loaded.service.getAllSecretVersions("JWT_SECRET")).toEqual(["jwt-v1"]);
    expect(loaded.service.getSecret("JWT_SECRET")).toBe("jwt-v1");
  });

  it("records primary first and previous second", async () => {
    const loaded = await loadConfigService({ secrets: [["MFA_ENCRYPTION_KEY", ["mfa-v2", "mfa-v1"]]] });
    await waitForInitialLoad(loaded);

    expect(loaded.service.getAllSecretVersions("MFA_ENCRYPTION_KEY")).toEqual(["mfa-v2", "mfa-v1"]);
    expect(loaded.service.getSecret("MFA_ENCRYPTION_KEY")).toBe("mfa-v2");
  });

  it("drops versions beyond the primary/previous pair", async () => {
    const loaded = await loadConfigService({ secrets: [["API_KEY", ["api-v3", "api-v2", "api-v1"]]] });
    await waitForInitialLoad(loaded);

    expect(loaded.service.getAllSecretVersions("API_KEY")).toEqual(["api-v3", "api-v2"]);
  });

  it("treats a blank second version as an absent previous version", async () => {
    const loaded = await loadConfigService({ secrets: [["WEBHOOK_SECRET", ["hook-v1", ""]]] });
    await waitForInitialLoad(loaded);

    expect(loaded.service.getAllSecretVersions("WEBHOOK_SECRET")).toEqual(["hook-v1"]);
  });

  it("treats an empty version list as an absent secret", async () => {
    const loaded = await loadConfigService({ secrets: [["WEBHOOK_SECRET", []]] });
    await waitForInitialLoad(loaded);

    expect(loaded.service.getAllSecretVersions("WEBHOOK_SECRET")).toEqual([]);
    expect(loaded.service.validateConfig("WEBHOOK_SECRET")).toBe(false);
    expect(() => loaded.service.getSecret("WEBHOOK_SECRET")).toThrow(loaded.module.ConfigError);
  });

  it("stores an empty primary but reports the key as invalid", async () => {
    const loaded = await loadConfigService({ secrets: [["JWT_SECRET", [""]]] });
    await waitForInitialLoad(loaded);

    expect(loaded.service.getSecret("JWT_SECRET")).toBe("");
    expect(loaded.service.validateConfig("JWT_SECRET")).toBe(false);
  });

  it("hands out a fresh array on every call so callers cannot corrupt service state", async () => {
    const loaded = await loadConfigService({
      secrets: [["STELLAR_SECRET_KEY", ["stellar-v2", "stellar-v1"]]],
    });
    await waitForInitialLoad(loaded);

    const first = loaded.service.getAllSecretVersions("STELLAR_SECRET_KEY");
    first.push("injected");
    first[0] = "tampered";

    expect(loaded.service.getAllSecretVersions("STELLAR_SECRET_KEY")).toEqual(["stellar-v2", "stellar-v1"]);
  });

  it("satisfies the documented compile-time shape", () => {
    const primaryOnly: SecretVersions = { primary: "p" };
    const rotated: SecretVersions = { primary: "p", previous: "prev" };

    expect(primaryOnly).toEqual({ primary: "p" });
    expect(rotated).toEqual({ primary: "p", previous: "prev" });
  });
});

// ─── Singleton ───────────────────────────────────────────────────────────────

describe("ConfigService.getInstance", () => {
  it("returns the same instance on repeated calls", async () => {
    const { module } = await loadConfigService();

    expect(module.ConfigService.getInstance()).toBe(module.ConfigService.getInstance());
  });

  it("returns the same instance as the eagerly exported configService singleton", async () => {
    const { module } = await loadConfigService();

    expect(module.configService).toBe(module.ConfigService.getInstance());
  });

  it("constructs a fresh singleton after the module registry is reset", async () => {
    const first = await loadConfigService();
    const second = await loadConfigService();

    expect(second.module.configService).not.toBe(first.module.configService);
  });

  it("exposes the documented public accessors on the prototype", async () => {
    const { service } = await loadConfigService();

    const members = new Set(Object.getOwnPropertyNames(Object.getPrototypeOf(service)));

    for (const name of [
      "getSecret",
      "getAllSecretVersions",
      "refresh",
      "validateConfig",
      "nodeEnv",
      "port",
      "timeoutMs",
      "rateLimitWindowMs",
      "rateLimitMax",
      "trustProxy",
      "webhookSecret",
      "internalOverrideSecret",
      "internalOverrideSecretPrev",
      "internalBypassToleranceMs",
      "mfaIssuer",
      "mfaFreshnessMs",
      "mfaWindowPeriods",
      "mfaChallengeTtlSec",
      "jwtIssuer",
      "jwtAudience",
      "corsAllowedOrigins",
    ]) {
      expect(members.has(name)).toBe(true);
    }
  });

  it("does not re-export env values that EnvConfig loads but ConfigService hides", async () => {
    const { service } = await loadConfigService();

    const accessors = Object.getOwnPropertyNames(Object.getPrototypeOf(service));

    expect(accessors).not.toContain("redisUrl");
    expect(accessors).not.toContain("horizonUrls");
    expect(accessors).not.toContain("networkPassphrase");
    expect(accessors).not.toContain("escrowContractHash");
  });
});

// ─── Environment-backed getters ──────────────────────────────────────────────

const GETTER_CASES: ReadonlyArray<{
  name: string;
  env: NodeJS.ProcessEnv;
  read: (service: ConfigServiceInstance) => unknown;
  configured: unknown;
  fallback: unknown;
}> = [
  {
    name: "nodeEnv",
    env: { NODE_ENV: "production" },
    read: (s) => s.nodeEnv,
    configured: "production",
    fallback: "development",
  },
  { name: "port", env: { PORT: "8080" }, read: (s) => s.port, configured: 8080, fallback: 3001 },
  {
    name: "timeoutMs",
    env: { REQUEST_TIMEOUT_MS: "1234" },
    read: (s) => s.timeoutMs,
    configured: 1234,
    fallback: 30_000,
  },
  {
    name: "rateLimitWindowMs",
    env: { RATE_LIMIT_WINDOW_MS: "60000" },
    read: (s) => s.rateLimitWindowMs,
    configured: 60_000,
    fallback: 900_000,
  },
  {
    name: "rateLimitMax",
    env: { RATE_LIMIT_MAX: "42" },
    read: (s) => s.rateLimitMax,
    configured: 42,
    fallback: 100,
  },
  {
    name: "trustProxy",
    env: { TRUST_PROXY: "true" },
    read: (s) => s.trustProxy,
    configured: true,
    fallback: false,
  },
  {
    name: "webhookSecret",
    env: { WEBHOOK_SECRET: "  hook-secret  " },
    read: (s) => s.webhookSecret,
    configured: "hook-secret",
    fallback: undefined,
  },
  {
    name: "internalOverrideSecret",
    env: { INTERNAL_OVERRIDE_SECRET: "bypass-live" },
    read: (s) => s.internalOverrideSecret,
    configured: "bypass-live",
    fallback: undefined,
  },
  {
    name: "internalOverrideSecretPrev",
    env: { INTERNAL_OVERRIDE_SECRET_PREV: "bypass-old" },
    read: (s) => s.internalOverrideSecretPrev,
    configured: "bypass-old",
    fallback: undefined,
  },
  {
    name: "internalBypassToleranceMs",
    env: { INTERNAL_BYPASS_TOLERANCE_MS: "45000" },
    read: (s) => s.internalBypassToleranceMs,
    configured: 45_000,
    fallback: 30_000,
  },
  {
    name: "mfaIssuer",
    env: { MFA_ISSUER: "ChronoPay" },
    read: (s) => s.mfaIssuer,
    configured: "ChronoPay",
    fallback: undefined,
  },
  {
    name: "mfaFreshnessMs",
    env: { MFA_FRESHNESS_MS: "60000" },
    read: (s) => s.mfaFreshnessMs,
    configured: 60_000,
    fallback: 900_000,
  },
  {
    name: "mfaWindowPeriods",
    env: { MFA_WINDOW_PERIODS: "2" },
    read: (s) => s.mfaWindowPeriods,
    configured: 2,
    fallback: 1,
  },
  {
    name: "mfaChallengeTtlSec",
    env: { MFA_CHALLENGE_TTL_SEC: "120" },
    read: (s) => s.mfaChallengeTtlSec,
    configured: 120,
    fallback: 300,
  },
  {
    name: "jwtIssuer",
    env: { JWT_ISSUER: "https://issuer.example" },
    read: (s) => s.jwtIssuer,
    configured: "https://issuer.example",
    fallback: undefined,
  },
  {
    name: "jwtAudience",
    env: { JWT_AUDIENCE: "revora-app" },
    read: (s) => s.jwtAudience,
    configured: "revora-app",
    fallback: undefined,
  },
  {
    name: "corsAllowedOrigins",
    env: { CORS_ALLOWED_ORIGINS: "https://a.example, https://b.example" },
    read: (s) => s.corsAllowedOrigins,
    configured: ["https://a.example", "https://b.example"],
    fallback: [],
  },
];

describe("ConfigService getters", () => {
  it.each(GETTER_CASES)("mirrors the environment for $name", async ({ env, read, configured }) => {
    const loaded = await loadConfigService({ env });

    expect(read(loaded.service)).toEqual(configured);
  });

  it.each(GETTER_CASES)("falls back to the documented default for $name", async ({ read, fallback }) => {
    const loaded = await loadConfigService();

    expect(read(loaded.service)).toEqual(fallback);
  });

  it.each(["", "   "])("treats whitespace-only optional secrets as unset (%p)", async (value) => {
    const loaded = await loadConfigService({
      env: {
        WEBHOOK_SECRET: value,
        INTERNAL_OVERRIDE_SECRET: value,
        INTERNAL_OVERRIDE_SECRET_PREV: value,
        MFA_ISSUER: value,
        JWT_ISSUER: value,
        JWT_AUDIENCE: value,
      },
    });

    expect(loaded.service.webhookSecret).toBeUndefined();
    expect(loaded.service.internalOverrideSecret).toBeUndefined();
    expect(loaded.service.internalOverrideSecretPrev).toBeUndefined();
    expect(loaded.service.mfaIssuer).toBeUndefined();
    expect(loaded.service.jwtIssuer).toBeUndefined();
    expect(loaded.service.jwtAudience).toBeUndefined();
  });

  it("returns a defensive copy of corsAllowedOrigins", async () => {
    const loaded = await loadConfigService({ env: { CORS_ALLOWED_ORIGINS: "https://a.example" } });

    const first = loaded.service.corsAllowedOrigins;
    first.push("https://evil.example");

    expect(loaded.service.corsAllowedOrigins).toEqual(["https://a.example"]);
  });

  it("drops blank entries from corsAllowedOrigins", async () => {
    const loaded = await loadConfigService({
      env: { CORS_ALLOWED_ORIGINS: "https://a.example, ,  ,https://b.example" },
    });

    expect(loaded.service.corsAllowedOrigins).toEqual(["https://a.example", "https://b.example"]);
  });

  it("builds the provider with the configured default TTL", async () => {
    const loaded = await loadConfigService({ env: { SECRET_CACHE_TTL_SECONDS: "42" } });

    expect(loaded.provider.options).toEqual({ defaultTtlSeconds: 42 });
  });

  it("defaults the provider TTL to 300 seconds when unset", async () => {
    const loaded = await loadConfigService();

    expect(loaded.provider.options).toEqual({ defaultTtlSeconds: 300 });
  });
});

// ─── getSecret ───────────────────────────────────────────────────────────────

describe("ConfigService.getSecret", () => {
  it("throws ConfigError for an unknown key", async () => {
    const loaded = await loadConfigService();

    expect(() => loaded.service.getSecret("NOT_A_CONFIGURED_KEY")).toThrow(loaded.module.ConfigError);
    expect(() => loaded.service.getSecret("NOT_A_CONFIGURED_KEY")).toThrow(
      "[ConfigService] Secret not found: NOT_A_CONFIGURED_KEY",
    );
  });

  it.each(["", "   "])("throws ConfigError for the blank key %p", async (key) => {
    const loaded = await loadConfigService();

    expect(() => loaded.service.getSecret(key)).toThrow(loaded.module.ConfigError);
  });

  it("names the missing key but never the loaded secret values", async () => {
    const loaded = await loadConfigService({ secrets: [["JWT_SECRET", ["super-secret-value"]]] });
    await waitForInitialLoad(loaded);

    try {
      loaded.service.getSecret("API_KEY");
      throw new Error("expected getSecret to throw");
    } catch (err) {
      expect((err as Error).name).toBe("ConfigError");
      expect((err as Error).message).toBe("[ConfigService] Secret not found: API_KEY");
      expect((err as Error).message).not.toContain("super-secret-value");
    }
  });

  it("is case sensitive with respect to the key", async () => {
    const loaded = await loadConfigService({ secrets: [["JWT_SECRET", ["jwt-v1"]]] });
    await waitForInitialLoad(loaded);

    expect(loaded.service.getSecret("JWT_SECRET")).toBe("jwt-v1");
    expect(() => loaded.service.getSecret("jwt_secret")).toThrow(loaded.module.ConfigError);
  });
});

// ─── getAllSecretVersions / validateConfig ───────────────────────────────────

describe("ConfigService.getAllSecretVersions", () => {
  it("returns an empty array for an unknown key", async () => {
    const loaded = await loadConfigService({ secrets: [["JWT_SECRET", ["jwt-v1"]]] });
    await waitForInitialLoad(loaded);

    expect(loaded.service.getAllSecretVersions("NOT_A_CONFIGURED_KEY")).toEqual([]);
  });

  it.each(["", "   "])("returns an empty array for the blank key %p", async (key) => {
    const loaded = await loadConfigService();

    expect(loaded.service.getAllSecretVersions(key)).toEqual([]);
  });

  it("never throws for a missing key, unlike getSecret", async () => {
    const loaded = await loadConfigService();

    expect(() => loaded.service.getAllSecretVersions("MFA_CHALLENGE_SECRET")).not.toThrow();
    expect(() => loaded.service.getSecret("MFA_CHALLENGE_SECRET")).toThrow();
  });
});

describe("ConfigService.validateConfig", () => {
  it("returns true once a non-empty primary is loaded", async () => {
    const loaded = await loadConfigService({ secrets: [["API_KEY", ["api-v1"]]] });
    await waitForInitialLoad(loaded);

    expect(loaded.service.validateConfig("API_KEY")).toBe(true);
  });

  it("returns false for an unknown key", async () => {
    const loaded = await loadConfigService();

    expect(loaded.service.validateConfig("NOT_A_CONFIGURED_KEY")).toBe(false);
  });

  it.each(["", "   "])("returns false for the blank key %p", async (key) => {
    const loaded = await loadConfigService();

    expect(loaded.service.validateConfig(key)).toBe(false);
  });
});

// ─── Invalid environment ─────────────────────────────────────────────────────

const INVALID_ENV_CASES: ReadonlyArray<{ label: string; env: NodeJS.ProcessEnv }> = [
  { label: "PORT below the allowed range", env: { PORT: "0" } },
  { label: "PORT above the allowed range", env: { PORT: "70000" } },
  { label: "a non-numeric PORT", env: { PORT: "not-a-port" } },
  { label: "a blank PORT", env: { PORT: "   " } },
  { label: "an unknown NODE_ENV", env: { NODE_ENV: "staging" } },
  { label: "a non-boolean TRUST_PROXY", env: { TRUST_PROXY: "yes" } },
  { label: "a zero RATE_LIMIT_MAX", env: { RATE_LIMIT_MAX: "0" } },
  { label: "a zero MFA_WINDOW_PERIODS", env: { MFA_WINDOW_PERIODS: "0" } },
  { label: "a non-http HORIZON_URL", env: { HORIZON_URL: "ftp://horizon.example" } },
  { label: "a REDIS_URL with embedded credentials", env: { REDIS_URL: "redis://u:p@localhost:6379" } },
];

describe("ConfigService invalid environment handling", () => {
  it.each(INVALID_ENV_CASES)("refuses to construct with $label", async ({ env }) => {
    prepare({ env });
    const envModule = await import("../env.js");

    await expect(import("../config.service.js")).rejects.toThrow(envModule.EnvValidationError);
  });

  it("surfaces every offending key in a single aggregated failure", async () => {
    prepare({ env: { PORT: "0", TRUST_PROXY: "yes", MFA_WINDOW_PERIODS: "0" } });
    const envModule = await import("../env.js");

    try {
      await import("../config.service.js");
      throw new Error("expected the import to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(envModule.EnvValidationError);
      const issues = (err as InstanceType<EnvModule["EnvValidationError"]>).issues;
      expect(issues.length).toBe(3);
      expect(issues.join(" ")).toContain("PORT");
      expect(issues.join(" ")).toContain("TRUST_PROXY");
      expect(issues.join(" ")).toContain("MFA_WINDOW_PERIODS");
    }
  });

  it("does not echo the rejected raw value in the error message", async () => {
    prepare({ env: { PORT: "70000" } });

    try {
      await import("../config.service.js");
      throw new Error("expected the import to reject");
    } catch (err) {
      expect((err as Error).message).not.toContain("70000");
    }
  });
});

describe("ConfigService.refresh with an invalid environment", () => {
  it("throws EnvValidationError synchronously", async () => {
    const loaded = await loadConfigService();
    process.env.PORT = "0";

    expect(() => loaded.service.refresh()).toThrow(loaded.env.EnvValidationError);
  });

  it("keeps the last known-good env snapshot when validation fails", async () => {
    const loaded = await loadConfigService({ env: { PORT: "3001", RATE_LIMIT_MAX: "7" } });
    process.env.PORT = "0";

    expect(() => loaded.service.refresh()).toThrow();

    expect(loaded.service.port).toBe(3001);
    expect(loaded.service.rateLimitMax).toBe(7);
  });

  it("leaves the loaded secrets untouched when validation fails", async () => {
    const loaded = await loadConfigService({ secrets: [["JWT_SECRET", ["jwt-v1"]]] });
    await waitForInitialLoad(loaded);
    process.env.PORT = "0";

    expect(() => loaded.service.refresh()).toThrow();

    expect(loaded.service.getSecret("JWT_SECRET")).toBe("jwt-v1");
  });
});

// ─── Primary state transitions ───────────────────────────────────────────────

describe("ConfigService secret state transitions", () => {
  it("requests exactly the six relevant keys, in order, on the initial sweep", async () => {
    const loaded = await loadConfigService();
    await waitForInitialLoad(loaded);

    expect(loaded.provider.requestedKeys).toEqual([...SWEPT_SECRET_KEYS]);
  });

  it("hydrates every key the provider exposes", async () => {
    const loaded = await loadConfigService({
      secrets: [
        ["JWT_SECRET", ["jwt-v1"]],
        ["API_KEY", ["api-v1", "api-v0"]],
        ["STELLAR_SECRET_KEY", ["stellar-v1"]],
        ["WEBHOOK_SECRET", ["hook-v1"]],
        ["MFA_ENCRYPTION_KEY", ["mfa-key-v1"]],
        ["MFA_CHALLENGE_SECRET", ["mfa-challenge-v1"]],
      ],
    });
    await waitForInitialLoad(loaded);
    const { service } = loaded;

    expect(service.getSecret("JWT_SECRET")).toBe("jwt-v1");
    expect(service.getAllSecretVersions("API_KEY")).toEqual(["api-v1", "api-v0"]);
    expect(service.getSecret("STELLAR_SECRET_KEY")).toBe("stellar-v1");
    expect(service.getSecret("WEBHOOK_SECRET")).toBe("hook-v1");
    expect(service.getSecret("MFA_ENCRYPTION_KEY")).toBe("mfa-key-v1");
    expect(service.getSecret("MFA_CHALLENGE_SECRET")).toBe("mfa-challenge-v1");
  });

  it("re-reads the environment on refresh", async () => {
    const loaded = await loadConfigService({ env: { PORT: "3001" } });
    expect(loaded.service.port).toBe(3001);

    process.env.PORT = "9090";
    loaded.service.refresh();

    expect(loaded.service.port).toBe(9090);
  });

  it("clears the previous snapshot synchronously during refresh, then repopulates", async () => {
    const loaded = await loadConfigService({ secrets: [["JWT_SECRET", ["jwt-v1"]]] });
    await waitForInitialLoad(loaded);

    loaded.service.refresh();

    expect(loaded.service.getAllSecretVersions("JWT_SECRET")).toEqual([]);
    expect(() => loaded.service.getSecret("JWT_SECRET")).toThrow(loaded.module.ConfigError);

    await completeSweeps(loaded.provider, 2);
    expect(loaded.service.getSecret("JWT_SECRET")).toBe("jwt-v1");
  });

  it("reloads secrets from the provider on refresh", async () => {
    const loaded = await loadConfigService({ secrets: [["JWT_SECRET", ["jwt-v1"]]] });
    await waitForInitialLoad(loaded);

    loaded.provider.setVersions("JWT_SECRET", ["jwt-v2", "jwt-v1"]);
    loaded.service.refresh();
    await completeSweeps(loaded.provider, 2);

    expect(loaded.service.getAllSecretVersions("JWT_SECRET")).toEqual(["jwt-v2", "jwt-v1"]);
    expect(loaded.service.getSecret("JWT_SECRET")).toBe("jwt-v2");
  });

  it("drops a secret the provider no longer exposes on refresh", async () => {
    const loaded = await loadConfigService({ secrets: [["JWT_SECRET", ["jwt-v1"]]] });
    await waitForInitialLoad(loaded);

    loaded.provider.setVersions("JWT_SECRET", []);
    loaded.service.refresh();
    await completeSweeps(loaded.provider, 2);

    expect(loaded.service.validateConfig("JWT_SECRET")).toBe(false);
    expect(() => loaded.service.getSecret("JWT_SECRET")).toThrow(
      "[ConfigService] Secret not found: JWT_SECRET",
    );
  });

  it("clears the previous snapshot synchronously when the provider emits rotate", async () => {
    const loaded = await loadConfigService({ secrets: [["JWT_SECRET", ["jwt-v1"]]] });
    await waitForInitialLoad(loaded);

    loaded.provider.rotate();

    expect(loaded.service.getAllSecretVersions("JWT_SECRET")).toEqual([]);

    await completeSweeps(loaded.provider, 2);
    expect(loaded.service.getSecret("JWT_SECRET")).toBe("jwt-v1");
  });

  it("refreshes in-memory secrets when the provider emits rotate", async () => {
    const loaded = await loadConfigService({ secrets: [["JWT_SECRET", ["jwt-v1"]]] });
    await waitForInitialLoad(loaded);

    loaded.provider.setVersions("JWT_SECRET", ["jwt-v2", "jwt-v1"]);
    loaded.provider.rotate();
    await completeSweeps(loaded.provider, 2);

    expect(loaded.service.getAllSecretVersions("JWT_SECRET")).toEqual(["jwt-v2", "jwt-v1"]);
    expect(loaded.service.getSecret("JWT_SECRET")).toBe("jwt-v2");
  });

  it("handles a rotate event that carries no key", async () => {
    const loaded = await loadConfigService({ secrets: [["API_KEY", ["api-v1"]]] });
    await waitForInitialLoad(loaded);

    loaded.provider.setVersions("API_KEY", ["api-v2"]);
    loaded.provider.rotate();
    await completeSweeps(loaded.provider, 2);

    expect(loaded.service.getAllSecretVersions("API_KEY")).toEqual(["api-v2"]);
  });

  it("promotes previous to primary across two rotations", async () => {
    const loaded = await loadConfigService({ secrets: [["JWT_SECRET", ["jwt-v1"]]] });
    await waitForInitialLoad(loaded);

    loaded.provider.setVersions("JWT_SECRET", ["jwt-v2", "jwt-v1"]);
    loaded.provider.rotate("JWT_SECRET");
    await completeSweeps(loaded.provider, 2);
    expect(loaded.service.getAllSecretVersions("JWT_SECRET")).toEqual(["jwt-v2", "jwt-v1"]);

    loaded.provider.setVersions("JWT_SECRET", ["jwt-v3"]);
    loaded.provider.rotate("JWT_SECRET");
    await completeSweeps(loaded.provider, 3);

    expect(loaded.service.getAllSecretVersions("JWT_SECRET")).toEqual(["jwt-v3"]);
    expect(loaded.service.getSecret("JWT_SECRET")).toBe("jwt-v3");
  });

  it("skips keys the provider fails on and still loads the rest", async () => {
    const loaded = await loadConfigService({
      secrets: [["API_KEY", ["api-v1"]]],
      failures: [["JWT_SECRET", "vault unreachable"]],
    });
    await waitForInitialLoad(loaded);

    expect(loaded.service.getSecret("API_KEY")).toBe("api-v1");
    expect(loaded.service.validateConfig("JWT_SECRET")).toBe(false);
    expect(() => loaded.service.getSecret("JWT_SECRET")).toThrow(loaded.module.ConfigError);
  });

  it("reports a provider failure as ConfigError without leaking the provider message", async () => {
    const loaded = await loadConfigService({ failures: [["JWT_SECRET", "vault unreachable"]] });
    await waitForInitialLoad(loaded);

    try {
      loaded.service.getSecret("JWT_SECRET");
      throw new Error("expected getSecret to throw");
    } catch (err) {
      expect((err as Error).name).toBe("ConfigError");
      expect((err as Error).message).toBe("[ConfigService] Secret not found: JWT_SECRET");
      expect((err as Error).message).not.toContain("vault unreachable");
    }
  });

  it("recovers a previously failing key on the next sweep", async () => {
    const loaded = await loadConfigService({ failures: [["JWT_SECRET", "vault unreachable"]] });
    await waitForInitialLoad(loaded);
    expect(() => loaded.service.getSecret("JWT_SECRET")).toThrow();

    loaded.provider.setVersions("JWT_SECRET", ["jwt-v1"]);
    loaded.service.refresh();
    await completeSweeps(loaded.provider, 2);

    expect(loaded.service.getSecret("JWT_SECRET")).toBe("jwt-v1");
    expect(loaded.service.validateConfig("JWT_SECRET")).toBe(true);
  });
});
