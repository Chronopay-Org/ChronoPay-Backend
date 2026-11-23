/**
 * Focused behavior coverage for `src/config/jwt.ts`.
 *
 * The module exposes the `JwtSecretVersion` / `JwtConfig` shapes plus
 * `getJwtConfig()` (env-backed issuer/audience) and `getAllSecretVersions()`
 * (labels the rotation chain). It reads through the `configService` singleton,
 * so every case resets the module registry, sets the environment, then imports
 * the module fresh — the same pattern already used by the secrets provider
 * suite.
 */

import { describe, it, expect, jest, afterEach } from "@jest/globals";
import type { JwtConfig, JwtSecretVersion } from "../jwt.js";

const ENV_KEYS = ["JWT_ISSUER", "JWT_AUDIENCE", "JWT_SECRET", "JWT_SECRET_PREV"] as const;

const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

async function loadJwt() {
  jest.resetModules();
  return await import("../jwt.js");
}

async function waitFor<T>(read: () => T, isReady: (value: T) => boolean, timeoutMs = 1000) {
  const start = Date.now();
  let value = read();
  while (!isReady(value) && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = read();
  }
  return value;
}

afterEach(() => {
  restoreEnv();
  jest.resetModules();
});

// ─── JwtConfig / getJwtConfig ────────────────────────────────────────────────

describe("getJwtConfig", () => {
  it("mirrors JWT_ISSUER and JWT_AUDIENCE from the environment", async () => {
    clearEnv();
    process.env.JWT_ISSUER = "https://issuer.example";
    process.env.JWT_AUDIENCE = "revora-app";

    const { getJwtConfig } = await loadJwt();

    expect(getJwtConfig()).toEqual({
      issuer: "https://issuer.example",
      audience: "revora-app",
    });
  });

  it("trims surrounding whitespace from both values", async () => {
    clearEnv();
    process.env.JWT_ISSUER = "  https://issuer.example  ";
    process.env.JWT_AUDIENCE = "  revora-app  ";

    const { getJwtConfig } = await loadJwt();

    expect(getJwtConfig()).toEqual({
      issuer: "https://issuer.example",
      audience: "revora-app",
    });
  });

  it("omits both optional fields when the env is empty", async () => {
    clearEnv();

    const { getJwtConfig } = await loadJwt();

    expect(getJwtConfig()).toEqual({ issuer: undefined, audience: undefined });
  });

  it("treats whitespace-only values as unset", async () => {
    clearEnv();
    process.env.JWT_ISSUER = "   ";

    const { getJwtConfig } = await loadJwt();

    expect(getJwtConfig().issuer).toBeUndefined();
  });

  it("returns a fresh object on every call (no shared mutable state)", async () => {
    clearEnv();
    process.env.JWT_ISSUER = "https://issuer.example";

    const { getJwtConfig } = await loadJwt();
    const first = getJwtConfig();
    first.issuer = "mutated";

    expect(getJwtConfig().issuer).toBe("https://issuer.example");
  });

  it("satisfies the JwtConfig contract for empty and fully-populated shapes", () => {
    const empty: JwtConfig = {};
    const populated: JwtConfig = { issuer: "i", audience: "a" };

    expect(empty).toEqual({});
    expect(populated).toEqual({ issuer: "i", audience: "a" });
  });
});

// ─── JwtSecretVersion / getAllSecretVersions ─────────────────────────────────

describe("getAllSecretVersions", () => {
  it("labels the rotation chain primary -> previous-N with active=true", async () => {
    clearEnv();
    process.env.JWT_SECRET = "primary-secret";
    process.env.JWT_SECRET_PREV = "previous-secret";

    const { getAllSecretVersions } = await loadJwt();
    const versions = await waitFor(
      () => getAllSecretVersions("JWT_SECRET"),
      (v) => v.length > 0,
    );

    expect(versions).toEqual([
      { version: "primary", secret: "primary-secret", active: true },
      { version: "previous-1", secret: "previous-secret", active: true },
    ]);
  });

  it("returns only the primary version when no previous secret is set", async () => {
    clearEnv();
    process.env.JWT_SECRET = "only-primary";

    const { getAllSecretVersions } = await loadJwt();
    const versions = await waitFor(
      () => getAllSecretVersions("JWT_SECRET"),
      (v) => v.length > 0,
    );

    expect(versions).toEqual([
      { version: "primary", secret: "only-primary", active: true },
    ]);
  });

  it("returns an empty array for an unknown key", async () => {
    clearEnv();
    process.env.JWT_SECRET = "primary-secret";

    const { getAllSecretVersions } = await loadJwt();
    await waitFor(
      () => getAllSecretVersions("JWT_SECRET"),
      (v) => v.length > 0,
    );

    expect(getAllSecretVersions("NOT_A_CONFIGURED_KEY")).toEqual([]);
  });

  it("exposes the documented JwtSecretVersion shape", () => {
    const version: JwtSecretVersion = {
      version: "primary",
      secret: "s3cr3t",
      active: true,
    };

    expect(Object.keys(version).sort()).toEqual(["active", "secret", "version"]);
    expect(typeof version.active).toBe("boolean");
  });
});
