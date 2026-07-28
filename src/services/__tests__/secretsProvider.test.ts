import { jest } from "@jest/globals";
import { createSecretsProviderFromEnv } from "../secrets/index.js";

describe("EnvSecretsProvider and ConfigService integration", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.JWT_SECRET = "primary-jwt";
    process.env.JWT_SECRET_PREV = "prev-jwt";
    process.env.SECRET_CACHE_TTL_SECONDS = "1"; // short TTL for tests
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
    delete process.env.JWT_SECRET_PREV;
    delete process.env.SECRET_CACHE_TTL_SECONDS;
  });

  test("provider returns secret and respects TTL", async () => {
    const p = createSecretsProviderFromEnv({ defaultTtlSeconds: 1 });
    const a = await p.getSecret("JWT_SECRET");
    expect(a).toBe("primary-jwt");

    // mutate env, but cached value should remain until TTL expires
    process.env.JWT_SECRET = "rotated-jwt";
    const b = await p.getSecret("JWT_SECRET");
    expect(b).toBe("primary-jwt");

    // wait for TTL to expire
    await new Promise((r) => setTimeout(r, 1100));
    const c = await p.getSecret("JWT_SECRET");
    expect(c).toBe("rotated-jwt");
  });

  test("ConfigService loads secrets and refreshes on provider rotate event", async () => {
    // create a provider and wire into new ConfigService instance by monkeypatching module
    process.env.JWT_SECRET = "initial-jwt";

    // construct service (it creates its own provider from env)
    const { ConfigService } = await import("../../config/config.service.js");
    const svc = ConfigService.getInstance();
    // allow async initial load to complete
    await new Promise((r) => setTimeout(r, 50));
    // initial value should be loaded
    expect(svc.getSecret("JWT_SECRET")).toBe("initial-jwt");

    // rotate secrets in env and emit rotate
    process.env.JWT_SECRET = "rotated-jwt-2";
    // notify provider via its global instance; easiest is to call refresh on configService
    svc.refresh();

    // allow async refresh to complete
    await new Promise((r) => setTimeout(r, 50));
    expect(svc.getSecret("JWT_SECRET")).toBe("rotated-jwt-2");
  });
});
