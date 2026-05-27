import request from "supertest";
import app from "../index.js";
import { configService } from "../config/config.service.js";
import { signJwt } from "../utils/jwt.js";

const JWT_ISSUER = "chronopay";
const CURRENT_SECRET = "secret-v2";
const PREVIOUS_SECRET = "secret-v1";

async function makeToken(secret: string, options?: { issuer?: string; expiresInSec?: number }) {
  return signJwt({ sub: "alice", role: "customer" }, secret, {
    issuer: options?.issuer,
    expiresInSec: options?.expiresInSec ?? 60,
  });
}

describe("JWT verification middleware", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = CURRENT_SECRET;
    process.env.JWT_SECRET_PREV = PREVIOUS_SECRET;
    process.env.JWT_ISSUER = JWT_ISSUER;
    configService.refresh();
  });

  it("accepts a valid token", async () => {
    const token = await makeToken(CURRENT_SECRET, { issuer: JWT_ISSUER });
    const res = await request(app).post("/api/v1/auth/verify").send({ token });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.actor.sub).toBe("alice");
  });

  it("rejects an expired token", async () => {
    const token = await makeToken(CURRENT_SECRET, { issuer: JWT_ISSUER, expiresInSec: -10 });
    const res = await request(app).post("/api/v1/auth/verify").send({ token });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("rejects a token with the wrong signature", async () => {
    const token = await makeToken("wrong-secret", { issuer: JWT_ISSUER });
    const res = await request(app).post("/api/v1/auth/verify").send({ token });

    expect(res.status).toBe(401);
  });

  it("rejects a token with a missing issuer claim", async () => {
    const token = await makeToken(CURRENT_SECRET, { expiresInSec: 60 });
    const res = await request(app).post("/api/v1/auth/verify").send({ token });

    expect(res.status).toBe(401);
  });

  it("accepts a token signed with a rotated secret", async () => {
    const token = await makeToken(PREVIOUS_SECRET, { issuer: JWT_ISSUER });
    const res = await request(app).post("/api/v1/auth/verify").send({ token });

    expect(res.status).toBe(200);
    expect(res.body.actor.sub).toBe("alice");
  });
});
