import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { requireAuth } from "../auth.js";
import { requireFreshMfa } from "../requireFreshMfa.js";
import { configService } from "../../config/config.service.js";
import { signJwt } from "../../utils/jwt.js";
import { flushMicrotasks } from "../../test-helpers/fakeMfaRepository.js";

const ACCESS_SECRET = "primary-access-secret-12345";
const CHALLENGE_SECRET = "mfa-challenge-secret-12345";
const ISSUER = "test-issuer";
const AUDIENCE = "test-audience";

async function accessToken(sub: string): Promise<string> {
  return signJwt(
    { sub, role: "customer", iat: Math.floor(Date.now() / 1000) },
    ACCESS_SECRET,
    { expiresInSec: 3600, issuer: ISSUER, audience: AUDIENCE },
  );
}

async function mfaToken(
  sub: string,
  options: { iatSec?: number; ttlSec?: number; secret?: string } = {},
): Promise<string> {
  const iat = options.iatSec ?? Math.floor(Date.now() / 1000);
  return signJwt(
    { sub, iat, mfa_at: iat },
    options.secret ?? CHALLENGE_SECRET,
    { expiresInSec: options.ttlSec ?? 3600, issuer: ISSUER, audience: AUDIENCE },
  );
}

describe("requireFreshMfa middleware", () => {
  let app: express.Express;

  const buildApp = (overrides: { maxAgeMs?: number; challengeSecret?: string; nowMs?: number } = {}) => {
    const testApp = express();
    testApp.use(requireAuth());
    testApp.get(
      "/protected",
      requireFreshMfa({
        maxAgeMs: overrides.maxAgeMs,
        challengeSecret: overrides.challengeSecret,
        issuer: ISSUER,
        audience: AUDIENCE,
        nowMs: overrides.nowMs,
      }),
      (_req, res) => res.status(200).json({ success: true }),
    );
    return testApp;
  };

  const buildNakedApp = () => {
    const testApp = express();
    testApp.get(
      "/naked",
      requireFreshMfa({ challengeSecret: CHALLENGE_SECRET, issuer: ISSUER, audience: AUDIENCE }),
      (_req, res) => res.status(200).json({ success: true }),
    );
    return testApp;
  };

  beforeAll(() => {
    process.env.JWT_SECRET = ACCESS_SECRET;
    process.env.JWT_ISSUER = ISSUER;
    process.env.JWT_AUDIENCE = AUDIENCE;
    process.env.MFA_CHALLENGE_SECRET = CHALLENGE_SECRET;
    configService.refresh();
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    delete process.env.MFA_CHALLENGE_SECRET;
    configService.refresh();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    app = buildApp();
  });

  it("rejects a request with no MFA header", async () => {
    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${await accessToken("user-1")}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, error: "Missing MFA challenge" });
  });

  it("rejects an empty MFA header", async () => {
    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${await accessToken("user-1")}`)
      .set("x-chronopay-mfa", "   ");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, error: "Missing MFA challenge" });
  });

  it("rejects when the request is not authenticated at all", async () => {
    const res = await request(buildNakedApp())
      .get("/naked")
      .set("x-chronopay-mfa", await mfaToken("user-1"));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, error: "Authentication required" });
  });

  it("allows a fresh, user-bound challenge", async () => {
    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${await accessToken("user-1")}`)
      .set("x-chronopay-mfa", await mfaToken("user-1"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it("rejects a challenge issued for a different user", async () => {
    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${await accessToken("user-1")}`)
      .set("x-chronopay-mfa", await mfaToken("user-2"));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: "Invalid MFA challenge" });
  });

  it("rejects a challenge signed with the wrong secret", async () => {
    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${await accessToken("user-1")}`)
      .set("x-chronopay-mfa", await mfaToken("user-1", { secret: "not-the-challenge-secret" }));
    expect(res.status).toBe(403);
  });

  it("rejects a stale challenge older than the freshness window", async () => {
    const staleIat = Math.floor(Date.now() / 1000) - 20 * 60;
    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${await accessToken("user-1")}`)
      .set("x-chronopay-mfa", await mfaToken("user-1", { iatSec: staleIat, ttlSec: 3600 }));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, error: "MFA challenge has expired; please verify again" });
  });

  it("honors a per-route freshness override", async () => {
    const barelyFresh = Math.floor(Date.now() / 1000) - 5 * 60;
    app = buildApp({ maxAgeMs: 10 * 60 * 1000 });
    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${await accessToken("user-1")}`)
      .set("x-chronopay-mfa", await mfaToken("user-1", { iatSec: barelyFresh, ttlSec: 3600 }));
    expect(res.status).toBe(200);
  });

  it("expires the challenge when its JWT lifetime elapses", async () => {
    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${await accessToken("user-1")}`)
      .set("x-chronopay-mfa", await mfaToken("user-1", { ttlSec: -10 }));
    expect(res.status).toBe(403);
  });

  it("returns 500 when the MFA challenge secret is not configured", async () => {
    app = buildApp();
    delete process.env.MFA_CHALLENGE_SECRET;
    configService.refresh();
    await flushMicrotasks();
    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${await accessToken("user-1")}`)
      .set("x-chronopay-mfa", await mfaToken("user-1"));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: "MFA is not configured" });
  });
});