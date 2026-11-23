import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { configService } from "../../config/config.service.js";
import { signJwt } from "../../utils/jwt.js";
import { optionalAuth } from "../auth.js";
import { setRedisClient, type RedisClient } from "../../cache/redisClient.js";
import { idempotencyMiddleware } from "../idempotency.js";

const JWT_SECRET = "optional-auth-secret-1234567890";

async function bearerToken(sub: string): Promise<string> {
  return signJwt(
    { sub, role: "customer", iat: Math.floor(Date.now() / 1000) },
    JWT_SECRET,
    { expiresInSec: 3600 },
  );
}

class InMemoryRedisMock implements RedisClient {
  private readonly store = new Map<string, { value: string }>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, { value });
    return "OK";
  }

  async del(key: string): Promise<unknown> {
    this.store.delete(key);
    return 1;
  }

  async keys(): Promise<string[]> {
    return [...this.store.keys()];
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  async quit(): Promise<unknown> {
    this.store.clear();
    return "OK";
  }
}

describe("optionalAuth middleware", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    configService.refresh();
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
    configService.refresh();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(optionalAuth());
    app.get("/me", (req, res) => {
      res.status(200).json({ userId: req.auth?.userId ?? null });
    });
    return app;
  }

  it("attaches req.auth when a valid Bearer token is presented", async () => {
    const response = await request(buildApp())
      .get("/me")
      .set("Authorization", `Bearer ${await bearerToken("user-42")}`);

    expect(response.status).toBe(200);
    expect(response.body.userId).toBe("user-42");
  });

  it("never rejects: leaves the request unauthenticated when no token is presented", async () => {
    const response = await request(buildApp()).get("/me");

    expect(response.status).toBe(200);
    expect(response.body.userId).toBeNull();
  });

  it("never rejects: leaves the request unauthenticated when the token is invalid", async () => {
    const response = await request(buildApp())
      .get("/me")
      .set("Authorization", "Bearer not-a-valid-jwt");

    expect(response.status).toBe(200);
    expect(response.body.userId).toBeNull();
  });
});

describe("optionalAuth before idempotencyMiddleware (checkout ordering)", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    configService.refresh();
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
    configService.refresh();
  });

  it("namespaces Idempotency-Key entries per verified caller", async () => {
    setRedisClient(new InMemoryRedisMock());
    let handlerExecutions = 0;

    const app = express();
    app.use(express.json());
    app.use(optionalAuth());
    app.post("/sessions", idempotencyMiddleware, (req, res) => {
      handlerExecutions += 1;
      res.status(201).json({ ok: true, owner: req.auth?.userId ?? null, run: handlerExecutions });
    });

    const payload = { payment: { amount: 1000, currency: "USD" } };
    const key = "checkout-shared-key-1";

    const first = await request(app)
      .post("/sessions")
      .set("Authorization", `Bearer ${await bearerToken("user-a")}`)
      .set("Idempotency-Key", key)
      .send(payload);
    const second = await request(app)
      .post("/sessions")
      .set("Authorization", `Bearer ${await bearerToken("user-b")}`)
      .set("Idempotency-Key", key)
      .send(payload);

    // Two verified callers reusing the same key value each get their own
    // response — never a replay of the other caller's cached body.
    expect(first.status).toBe(201);
    expect(first.body.owner).toBe("user-a");
    expect(second.status).toBe(201);
    expect(second.body.owner).toBe("user-b");
    expect(second.body).not.toEqual(first.body);
    expect(handlerExecutions).toBe(2);
  });
});
