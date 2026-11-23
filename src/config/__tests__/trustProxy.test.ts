import { describe, it, expect } from "@jest/globals";
import request from "supertest";
import express from "express";
import { loadEnvConfig, EnvValidationError } from "../env.js";

// ─── Validation ───────────────────────────────────────────────────────────────

describe("TRUST_PROXY env validation", () => {
  it.each(["true", "1"])("accepts truthy value %s → trustProxy=true", (val) => {
    const cfg = loadEnvConfig({ ...minEnv(), TRUST_PROXY: val });
    expect(cfg.trustProxy).toBe(true);
  });

  it.each(["false", "0"])("accepts falsy value %s → trustProxy=false", (val) => {
    const cfg = loadEnvConfig({ ...minEnv(), TRUST_PROXY: val });
    expect(cfg.trustProxy).toBe(false);
  });

  it("defaults to false when TRUST_PROXY is absent", () => {
    const cfg = loadEnvConfig(minEnv());
    expect(cfg.trustProxy).toBe(false);
  });

  it.each(["yes", "on", "1.0", "enabled", "tru"])(
    "rejects malformed value %s with descriptive error",
    (val) => {
      expect(() => loadEnvConfig({ ...minEnv(), TRUST_PROXY: val })).toThrow(
        EnvValidationError,
      );
      try {
        loadEnvConfig({ ...minEnv(), TRUST_PROXY: val });
      } catch (e) {
        const err = e as EnvValidationError;
        expect(err.issues).toContain(
          "TRUST_PROXY must be one of: true, false, 1, 0.",
        );
      }
    },
  );
});

// ─── XFF / req.ip behaviour ───────────────────────────────────────────────────

describe("X-Forwarded-For behaviour", () => {
  function makeApp(trustProxy: boolean) {
    const app = express();
    if (trustProxy) app.set("trust proxy", 1);
    app.get("/ip", (req, res) => res.json({ ip: req.ip }));
    return app;
  }

  it("honours X-Forwarded-For when trust proxy is enabled", async () => {
    const app = makeApp(true);
    const res = await request(app)
      .get("/ip")
      .set("X-Forwarded-For", "1.2.3.4");
    expect(res.status).toBe(200);
    expect(res.body.ip).toBe("1.2.3.4");
  });

  it("ignores X-Forwarded-For when trust proxy is disabled", async () => {
    const app = makeApp(false);
    const res = await request(app)
      .get("/ip")
      .set("X-Forwarded-For", "1.2.3.4");
    expect(res.status).toBe(200);
    // req.ip is the actual socket address (127.0.0.1 in supertest), not the spoofed header
    expect(res.body.ip).not.toBe("1.2.3.4");
  });

  it("spoofed XFF with trust on: Express picks rightmost IP (last trusted hop)", async () => {
    const app = makeApp(true);
    // trust proxy=1 means Express trusts one proxy hop and uses the rightmost XFF entry
    const res = await request(app)
      .get("/ip")
      .set("X-Forwarded-For", "9.9.9.9, 10.0.0.1");
    expect(res.body.ip).toBe("10.0.0.1");
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function minEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    REDIS_URL: "redis://localhost:6379",
  };
}
