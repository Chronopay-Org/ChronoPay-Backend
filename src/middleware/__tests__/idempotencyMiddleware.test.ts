/**
 * Adversarial / boundary coverage for `src/middleware/idempotency.ts` (#1112).
 *
 * The companion suite (`idempotency.test.ts`) covers the happy path, one
 * mismatch case, one concurrency case, TTL expiry and the codec. This suite
 * attacks the middleware's contract from the edges:
 *
 *   - opt-in semantics: absent vs empty vs malformed `Idempotency-Key`
 *   - replay fidelity: exact status + body for non-2xx responses
 *   - key scoping: method and URL are part of the request hash
 *   - lock lifecycle: processing -> completed, and what happens when the
 *     handler never emits a JSON body
 *   - dependency failure: Redis absent, Redis erroring, NX lost race
 *   - purity: a rejected request must not execute the handler twice
 *
 * Determinism: the fake Redis below is fully in-memory and synchronous unless
 * a test explicitly asks for a delayed completion write.
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "@jest/globals";
import { setRedisClient, type RedisClient } from "../../cache/redisClient.js";
import { idempotencyMiddleware } from "../idempotency.js";
import { ERROR_CODES } from "../../errors/errorCodes.js";
import { generateRequestHash } from "../../utils/hash.js";

type StoredEntry = { value: string; expiresAt?: number };
type SetRecord = {
  key: string;
  value: string;
  exMode: string;
  ttl: number;
  condition?: string;
};

/**
 * Instrumented in-memory Redis double.
 *
 * Records every `set` so TTL/flag usage can be asserted, and can be told to
 * fail a `get`, lose an `NX` race, or delay the (non-NX) completion write so a
 * competing request observes the "processing" state.
 */
class FakeRedis implements RedisClient {
  readonly store = new Map<string, StoredEntry>();
  readonly sets: SetRecord[] = [];

  /** When set, the next `get` rejects and the field is cleared. */
  failNextGet: Error | null = null;
  /** When true, the next NX `set` reports that another writer won the race. */
  loseNextNxRace = false;
  /** Delay applied to non-NX (completion) writes, in ms. */
  completionWriteDelayMs = 0;

  async get(key: string): Promise<string | null> {
    if (this.failNextGet) {
      const error = this.failNextGet;
      this.failNextGet = null;
      throw error;
    }
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(
    key: string,
    value: string,
    exMode: "EX",
    ttl: number,
    condition?: "NX",
  ): Promise<unknown> {
    this.sets.push({ key, value, exMode, ttl, condition });

    if (condition === "NX") {
      if (this.loseNextNxRace) {
        this.loseNextNxRace = false;
        return null;
      }
      if (this.store.has(key)) return null;
    } else if (this.completionWriteDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.completionWriteDelayMs));
    }

    const expiresAt = exMode === "EX" ? Date.now() + ttl * 1000 : undefined;
    this.store.set(key, { value, expiresAt });
    return "OK";
  }

  async del(key: string): Promise<unknown> {
    this.store.delete(key);
    return 1;
  }

  async keys(pattern: string): Promise<string[]> {
    const all = [...this.store.keys()];
    if (pattern === "*") return all;
    return all.filter((key) => key.startsWith(pattern.replace("*", "")));
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  async quit(): Promise<unknown> {
    this.store.clear();
    return "OK";
  }

  /** Synchronous inspection helper used while the handler is running. */
  peek(key: string): string | null {
    return this.store.get(key)?.value ?? null;
  }
}

const IDENTITY_MESSAGE = "handler ran";

type Handler = (req: express.Request, res: express.Response) => void;

interface Harness {
  app: express.Express;
  redis: FakeRedis;
  executions: () => number;
  /** Value of the idempotency key observed *inside* the handler. */
  observedDuringHandler: () => string | null;
}

function createHarness(
  handler?: Handler,
  options: { mountAltRoutes?: boolean; withErrorHandler?: boolean; throwInHandler?: boolean } = {},
): Harness {
  const redis = new FakeRedis();
  setRedisClient(redis);

  let executions = 0;
  let observed: string | null = null;

  const app = express();
  app.use(express.json());

  const run: Handler =
    handler ??
    ((req, res) => {
      executions += 1;
      const key = req.header("Idempotency-Key") as string;
      // Capture the lock state the handler can observe: it must already be
      // "processing" before any business logic runs.
      observed = redis.peek(`idempotency:req:${key}`);
      res.status(201).json({ message: IDENTITY_MESSAGE, run: executions, amount: req.body.amount });
    });

  const wrapped: Handler = (req, res) => {
    if (options.throwInHandler) {
      executions += 1;
      throw new Error("handler exploded");
    }
    run(req, res);
  };

  app.post("/payments", idempotencyMiddleware, wrapped);
  if (options.mountAltRoutes) {
    app.put("/payments", idempotencyMiddleware, wrapped);
    app.post("/payments/alt", idempotencyMiddleware, wrapped);
  }
  if (options.withErrorHandler) {
    app.use(
      (
        err: Error,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.status(500).json({ error: err.message });
      },
    );
  }

  return {
    app,
    redis,
    executions: () => executions,
    observedDuringHandler: () => observed,
  };
}

async function waitForCompletedEntry(redis: FakeRedis, key: string, timeoutMs = 500) {
  const storageKey = `idempotency:req:${key}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = redis.peek(storageKey);
    if (value && value.includes('"completed"')) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return redis.peek(storageKey);
}

describe("idempotencyMiddleware boundaries (#1112)", () => {
  beforeEach(() => {
    setRedisClient(null);
  });

  // ── Opt-in semantics ──────────────────────────────────────────────────────

  describe("opt-in behaviour", () => {
    it("never touches Redis when the header is absent", async () => {
      const { app, redis, executions } = createHarness();

      const first = await request(app).post("/payments").send({ amount: 10 });
      const second = await request(app).post("/payments").send({ amount: 10 });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(executions()).toBe(2);
      expect(redis.sets).toHaveLength(0);
      expect(redis.store.size).toBe(0);
    });

    it("treats an empty header value as absent (falsy guard) and does not lock", async () => {
      const { app, redis, executions } = createHarness();

      const first = await request(app).post("/payments").set("Idempotency-Key", "").send({});
      const second = await request(app).post("/payments").set("Idempotency-Key", "").send({});

      expect([first.status, second.status]).toEqual([201, 201]);
      expect(executions()).toBe(2);
      expect(redis.sets).toHaveLength(0);
    });
  });

  // ── Header validation ─────────────────────────────────────────────────────

  describe("malformed Idempotency-Key values", () => {
    it.each([
      ["embedded space", "bad key"],
      ["semicolon", "key;drop"],
      ["slash", "key/../../etc/passwd"],
    ])("rejects %s with 400 before touching Redis", async (_label, key) => {
      const { app, redis, executions } = createHarness();

      const response = await request(app).post("/payments").set("Idempotency-Key", key).send({});

      expect(response.status).toBe(400);
      expect(response.body.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_INVALID.code);
      expect(response.body.success).toBe(false);
      expect(executions()).toBe(0);
      expect(redis.sets).toHaveLength(0);
      expect(redis.store.size).toBe(0);
    });

    it("rejects a key longer than the documented 255 character limit", async () => {
      const { app, redis, executions } = createHarness();
      const oversized = "k".repeat(256);

      const response = await request(app)
        .post("/payments")
        .set("Idempotency-Key", oversized)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_INVALID.code);
      expect(executions()).toBe(0);
      expect(redis.sets).toHaveLength(0);
    });

    it("accepts a key at exactly the 255 character limit", async () => {
      const { app, executions } = createHarness();
      const boundary = "k".repeat(255);

      const response = await request(app)
        .post("/payments")
        .set("Idempotency-Key", boundary)
        .send({ amount: 1 });

      expect(response.status).toBe(201);
      expect(executions()).toBe(1);
    });

    it("accepts dots, hyphens and underscores in a key", async () => {
      const { app, executions } = createHarness();

      const response = await request(app)
        .post("/payments")
        .set("Idempotency-Key", "pay_1.0-alpha")
        .send({ amount: 1 });

      expect(response.status).toBe(201);
      expect(executions()).toBe(1);
    });
  });

  // ── Replay fidelity ───────────────────────────────────────────────────────

  describe("replay fidelity", () => {
    it("replays a non-2xx business response verbatim without re-running the handler", async () => {
      const { app, redis, executions } = createHarness((_req, res) => {
        res.status(409).json({ code: "INSUFFICIENT_FUNDS", retryable: false });
      });

      const first = await request(app)
        .post("/payments")
        .set("Idempotency-Key", "replay-409")
        .send({ amount: 9_999 });
      const second = await request(app)
        .post("/payments")
        .set("Idempotency-Key", "replay-409")
        .send({ amount: 9_999 });

      expect(first.status).toBe(409);
      expect(second.status).toBe(409);
      expect(second.body).toEqual(first.body);
      expect(redis.sets.filter((s) => !s.condition)).toHaveLength(1);
    });

    it("does not share the cache across distinct keys with identical payloads", async () => {
      const { app, executions } = createHarness();

      const first = await request(app)
        .post("/payments")
        .set("Idempotency-Key", "distinct-1")
        .send({ amount: 42 });
      const second = await request(app)
        .post("/payments")
        .set("Idempotency-Key", "distinct-2")
        .send({ amount: 42 });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.run).toBe(2);
      expect(executions()).toBe(2);
    });

    it("scopes the key to the HTTP method (same key + body, different verb -> 422)", async () => {
      const { app, executions } = createHarness(undefined, { mountAltRoutes: true });

      const post = await request(app)
        .post("/payments")
        .set("Idempotency-Key", "scoped-method")
        .send({ amount: 25 });
      const put = await request(app)
        .put("/payments")
        .set("Idempotency-Key", "scoped-method")
        .send({ amount: 25 });

      expect(post.status).toBe(201);
      expect(put.status).toBe(422);
      expect(put.body.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_MISMATCH.code);
      expect(executions()).toBe(1);
    });

    it("scopes the key to the URL path (same key + body, different path -> 422)", async () => {
      const { app, executions } = createHarness(undefined, { mountAltRoutes: true });

      const canonical = await request(app)
        .post("/payments")
        .set("Idempotency-Key", "scoped-url")
        .send({ amount: 25 });
      const alternative = await request(app)
        .post("/payments/alt")
        .set("Idempotency-Key", "scoped-url")
        .send({ amount: 25 });

      expect(canonical.status).toBe(201);
      expect(alternative.status).toBe(422);
      expect(executions()).toBe(1);
    });

    it("treats a query-string change as a different request", async () => {
      const { app, executions } = createHarness();
      const key = "scoped-query";

      const plain = await request(app)
        .post("/payments")
        .set("Idempotency-Key", key)
        .send({ amount: 25 });
      expect(plain.status).toBe(201);

      // `originalUrl` includes the query string, so this is a different request
      // hash and must not silently replay the first response.
      const withQuery = await request(app)
        .post("/payments?dryRun=true")
        .set("Idempotency-Key", key)
        .send({ amount: 25 });

      expect(withQuery.status).toBe(422);
      expect(withQuery.body.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_MISMATCH.code);
      expect(executions()).toBe(1);
    });
  });

  // ── Lock lifecycle ────────────────────────────────────────────────────────

  describe("lock lifecycle", () => {
    it("acquires the lock (processing) before the handler runs", async () => {
      const { app, observedDuringHandler, redis } = createHarness();

      await request(app)
        .post("/payments")
        .set("Idempotency-Key", "lock-order")
        .send({ amount: 7 });

      const observed = observedDuringHandler();
      expect(observed).not.toBeNull();
      expect(observed).toContain('"status":"processing"');
      expect(observed).toContain(
        generateRequestHash("POST", "/payments", { amount: 7 }),
      );
      expect(redis.sets[0].condition).toBe("NX");
    });

    it("transitions processing -> completed with the response status and body", async () => {
      const { app, redis } = createHarness();

      const response = await request(app)
        .post("/payments")
        .set("Idempotency-Key", "lock-complete")
        .send({ amount: 7 });

      const stored = await waitForCompletedEntry(redis, "lock-complete");
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored as string)).toMatchObject({
        status: "completed",
        statusCode: 201,
        responseBody: response.body,
        requestHash: generateRequestHash("POST", "/payments", { amount: 7 }),
      });
    });

    it("writes both states with a 24h TTL and no NX on the completion write", async () => {
      const { app, redis } = createHarness();

      await request(app)
        .post("/payments")
        .set("Idempotency-Key", "lock-ttl")
        .send({ amount: 1 });

      expect(redis.sets).toHaveLength(2);
      expect(redis.sets[0]).toMatchObject({ exMode: "EX", ttl: 86400, condition: "NX" });
      expect(redis.sets[1]).toMatchObject({ exMode: "EX", ttl: 86400 });
      expect(redis.sets[1].condition).toBeUndefined();
    });

    it("keeps the key locked when the handler never emits a JSON body", async () => {
      // Documented fail-closed behaviour: the lock is only released by
      // `res.json`, so a 204-style handler leaves the key in "processing"
      // until the TTL expires. Duplicate processing stays impossible, but the
      // key cannot be replayed either.
      const { app, executions } = createHarness((_req, res) => {
        res.sendStatus(204);
      });

      const first = await request(app)
        .post("/payments")
        .set("Idempotency-Key", "lock-no-json")
        .send({ amount: 3 });
      const second = await request(app)
        .post("/payments")
        .set("Idempotency-Key", "lock-no-json")
        .send({ amount: 3 });

      expect(first.status).toBe(204);
      expect(second.status).toBe(409);
      expect(second.body.code).toBe(ERROR_CODES.IDEMPOTENCY_IN_PROGRESS.code);
      expect(executions()).toBe(1);
    });

    it("persists an error envelope produced by the error handler and does not re-run the handler", async () => {
      const { app, executions } = createHarness(undefined, {
        withErrorHandler: true,
        throwInHandler: true,
      });

      const first = await request(app)
        .post("/payments")
        .set("Idempotency-Key", "lock-throw")
        .send({ amount: 3 });
      const second = await request(app)
        .post("/payments")
        .set("Idempotency-Key", "lock-throw")
        .send({ amount: 3 });

      expect(first.status).toBe(500);
      expect(second.status).toBe(500);
      expect(second.body).toEqual(first.body);
      expect(executions()).toBe(1);
    });
  });

  // ── Concurrency ───────────────────────────────────────────────────────────

  describe("concurrency", () => {
    it("serialises concurrent identical requests and unlocks afterwards", async () => {
      const { app, redis } = createHarness();
      redis.completionWriteDelayMs = 60;
      const key = "race-identical";

      const [first, second] = await Promise.all([
        request(app).post("/payments").set("Idempotency-Key", key).send({ amount: 500 }),
        request(app).post("/payments").set("Idempotency-Key", key).send({ amount: 500 }),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);
      const loser = first.status === 409 ? first : second;
      expect(loser.body.code).toBe(ERROR_CODES.IDEMPOTENCY_IN_PROGRESS.code);

      await waitForCompletedEntry(redis, key);

      const replayed = await request(app)
        .post("/payments")
        .set("Idempotency-Key", key)
        .send({ amount: 500 });
      expect(replayed.status).toBe(201);
      expect(replayed.body).toEqual((first.status === 201 ? first : second).body);
    });

    it("loses the NX race even when the key lookup returned nothing", async () => {
      const { app, redis, executions } = createHarness();
      redis.loseNextNxRace = true;

      const response = await request(app)
        .post("/payments")
        .set("Idempotency-Key", "race-lost-nx")
        .send({ amount: 12 });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe(ERROR_CODES.IDEMPOTENCY_IN_PROGRESS.code);
      expect(executions()).toBe(0);
      // Only the failed NX attempt was written; no completion write happened.
      expect(redis.store.has("idempotency:req:race-lost-nx")).toBe(false);
    });

    it("rejects a concurrent payload mismatch as in-progress before hash comparison", async () => {
      const { app, redis } = createHarness();
      redis.completionWriteDelayMs = 60;
      const key = "race-mismatch";

      const [first, second] = await Promise.all([
        request(app).post("/payments").set("Idempotency-Key", key).send({ amount: 100 }),
        request(app).post("/payments").set("Idempotency-Key", key).send({ amount: 999 }),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);

      await waitForCompletedEntry(redis, key);

      // Once the winner has completed, the losing payload is a hash mismatch.
      const afterCompletion = await request(app)
        .post("/payments")
        .set("Idempotency-Key", key)
        .send({ amount: 999 });
      expect(afterCompletion.status).toBe(422);
      expect(afterCompletion.body.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_MISMATCH.code);
    });
  });

  // ── Dependency failures ───────────────────────────────────────────────────

  describe("dependency failures", () => {
    it("still lets keyless requests through when Redis is unavailable", async () => {
      const { app } = createHarness();
      setRedisClient(null);

      const response = await request(app).post("/payments").send({ amount: 1 });

      expect(response.status).toBe(201);
    });

    it("fails closed with 503 and never runs the handler when Redis is unavailable", async () => {
      const { app, executions } = createHarness();
      setRedisClient(null);

      const response = await request(app)
        .post("/payments")
        .set("Idempotency-Key", "no-redis")
        .send({ amount: 1 });

      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        success: false,
        code: "DEPENDENCY_UNAVAILABLE",
      });
      expect(executions()).toBe(0);
    });

    it("propagates a Redis read failure to next(err) without caching anything", async () => {
      const { app, redis, executions } = createHarness(undefined, { withErrorHandler: true });
      redis.failNextGet = new Error("redis read failed");

      const response = await request(app)
        .post("/payments")
        .set("Idempotency-Key", "redis-error")
        .send({ amount: 1 });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("redis read failed");
      expect(executions()).toBe(0);
      // Nothing was persisted, so the key is reusable once Redis recovers.
      expect(redis.sets).toHaveLength(0);
      expect(redis.store.size).toBe(0);

      const recovered = await request(app)
        .post("/payments")
        .set("Idempotency-Key", "redis-error")
        .send({ amount: 1 });
      expect(recovered.status).toBe(201);
      expect(executions()).toBe(1);
    });
  });
});
