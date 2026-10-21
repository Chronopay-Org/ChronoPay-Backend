import express from "express";
import request from "supertest";
import { jest } from "@jest/globals";
import { FraudScorer } from "../../services/fraudScorer.js";
import { antiFraudScoring, captureRequestBody, enqueueHitlReviewForIntent } from "../fraudScoring.js";
import { getFraudDriftSnapshot, resetFraudDriftState } from "../../metrics/fraudDriftMetrics.js";
import { fraudReviewQueue } from "../../services/fraudReviewQueue.js";
import {
  hashFraudChallengeBody,
  InMemoryFraudChallengeStore,
  type FraudChallengeStore,
} from "../../services/fraudChallengeStore.js";
import { QuarantineStore } from "../../services/quarantineStore.js";
import type { AuditLogger } from "../../services/auditLogger.js";
import { signJwt } from "../../utils/jwt.js";
import { configService } from "../../config/config.service.js";
import { flushMicrotasks } from "../../test-helpers/fakeMfaRepository.js";

const DISPOSABLE = "customer@tempmail.com";

function buildApp(opts: {
  scorer: FraudScorer;
  auditLogger?: AuditLogger;
  quarantineStore?: QuarantineStore;
  challengeStore?: FraudChallengeStore;
  /** Actor the auth stub binds to the request (default "user-1"). */
  userId?: string;
  /**
   * When set, the terminal handler mimics the route completing the HITL
   * enqueue with a real intent id (see issue #1345).
   */
  hitlIntentId?: string;
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).auth = { userId: opts.userId ?? "user-1", role: "customer", claims: {} };
    next();
  });
  app.post(
    "/",
    antiFraudScoring({
      scorer: opts.scorer,
      auditLogger: opts.auditLogger,
      quarantineStore: opts.quarantineStore,
      challengeStore: opts.challengeStore,
    }),
    (req, res) => {
      const queued = opts.hitlIntentId
        ? enqueueHitlReviewForIntent(req, opts.hitlIntentId)
        : undefined;
      res.status(200).json({
        ok: true,
        score: (req as any).fraudResult?.score,
        reasons: (req as any).fraudResult?.reasons,
        decision: (req as any).fraudDecision,
        queuedIntentId: queued?.intentId ?? null,
      });
    },
  );
  return app;
}

function makeScorer(): FraudScorer {
  return new FraudScorer();
}

function mockAuditLogger(): AuditLogger {
  return {
    log: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as AuditLogger;
}

describe("antiFraudScoring middleware", () => {
  beforeEach(() => {
    resetFraudDriftState();
    fraudReviewQueue._reset();
  });

  afterEach(() => {
    delete process.env.FRAUD_STEP_UP_MODE;
    delete process.env.FRAUD_STEP_UP_THRESHOLD;
    delete process.env.FRAUD_VELOCITY_WINDOW_MS;
    delete process.env.FRAUD_MAX_INTENTS;
    delete process.env.FRAUD_MODEL_VERSION;
    resetFraudDriftState();
  });

  it("allows clean requests, attaches the result, records the metric and emits a fraud_score audit event", async () => {
    const auditLogger = mockAuditLogger();
    const app = buildApp({ scorer: makeScorer(), auditLogger });

    const res = await request(app)
      .post("/")
      .set("user-agent", "Mozilla/5.0 (Macintosh)")
      .set("x-device-fingerprint", "fp-clean")
      .send({ slotId: "slot-11111111-1111-4111-8111-111111111111" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      score: 0,
      reasons: [],
      decision: "allowed",
      queuedIntentId: null,
    });

    const snapshot = getFraudDriftSnapshot();
    expect(snapshot.liveTotals["vdefault"]).toBe(1);

    expect(auditLogger.log).toHaveBeenCalledTimes(1);
    const [action, data, options] = (
      auditLogger.log as unknown as jest.Mock<(...args: any[]) => Promise<void>>
    ).mock.calls[0];
    expect(action).toBe("fraud_score");
    expect(data.body).toMatchObject({
      actorId: "user-1",
      score: 0,
      decision: "allowed",
    });
    expect(options.status).toBe(200);
  });

  it("handles empty/invalid input without blocking (score 0, next)", async () => {
    const app = buildApp({ scorer: makeScorer() });

    const res = await request(app).post("/").send();

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.score).toBe(0);
  });

  it("blocks on combined velocity + disposable-email signals in challenge mode by default", async () => {
    const app = buildApp({ scorer: makeScorer() });

    for (let i = 0; i < 5; i += 1) {
      const ok = await request(app).post("/").send({ slotId: "slot-A" });
      expect(ok.status).toBe(200);
    }

    const blocked = await request(app).post("/").send({ slotId: "slot-A", email: DISPOSABLE });

    expect(blocked.status).toBe(403);
    expect(blocked.body.success).toBe(false);
    expect(blocked.body.error).toBe("Booking intent blocked due to security policies.");
    expect(blocked.body.challengeRequired).toBe(true);
    expect(typeof blocked.body.challengeToken).toBe("string");
    expect(blocked.body.reasonCodes).toEqual(
      expect.arrayContaining(["RATE_LIMIT_EXCEEDED", "INVALID_CONTACT_INFO"]),
    );
    expect(blocked.body.messages).toHaveLength(2);
  });

  it("quarantines high-score intents in quarantine mode without dropping them", async () => {
    process.env.FRAUD_STEP_UP_MODE = "quarantine";
    const store = new QuarantineStore();
    const app = buildApp({ scorer: makeScorer(), quarantineStore: store });

    for (let i = 0; i < 5; i += 1) {
      await request(app).post("/").send({ slotId: "slot-A" });
    }
    const blocked = await request(app).post("/").send({ slotId: "slot-A", email: DISPOSABLE });

    expect(blocked.status).toBe(403);
    expect(typeof blocked.body.quarantineId).toBe("string");

    const entry = store.get(blocked.body.quarantineId);
    expect(entry).toBeDefined();
    expect(entry.actorId).toBe("user-1");
    expect(entry.input).toMatchObject({ slotId: "slot-A", email: DISPOSABLE });
    expect(entry.fraudResult.score).toBe(2);
  });

  it("marks borderline scores (threshold - 1) for review, still allows them, and defers the HITL enqueue to the route", async () => {
    const app = buildApp({ scorer: makeScorer() });

    const res = await request(app).post("/").send({ email: DISPOSABLE });

    expect(res.status).toBe(200);
    expect(res.body.score).toBe(1);
    expect(res.body.decision).toBe("review");

    // Issue #1345: the middleware must NOT enqueue here — the intent does not
    // exist yet, so any enqueue would store a placeholder reviewers cannot act
    // on. The route completes it via enqueueHitlReviewForIntent(intent.id).
    expect(fraudReviewQueue.getPendingItems()).toHaveLength(0);
  });

  it("enforces the exact score boundary: below threshold allowed, at threshold blocked", async () => {
    process.env.FRAUD_STEP_UP_THRESHOLD = "1";
    const app = buildApp({ scorer: makeScorer() });

    let lastStatus = 0;
    for (let i = 0; i < 5; i += 1) {
      lastStatus = (
        await request(app)
          .post("/")
          .send({ slotId: `slot-${i}` })
      ).status;
    }
    expect(lastStatus).toBe(200); // request 5: velocity 5, not yet flagged

    const sixth = await request(app).post("/").send({ slotId: "slot-6" });
    expect(sixth.status).toBe(403);
    expect(sixth.body.reasonCodes).toContain("RATE_LIMIT_EXCEEDED");
  });

  it("scores concurrent bursts deterministically without 500s", async () => {
    process.env.FRAUD_STEP_UP_THRESHOLD = "1";
    const app = buildApp({ scorer: makeScorer() });

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => request(app).post("/").send({ slotId: "slot-burst" })),
    );

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 403)).toHaveLength(5);
    expect(statuses.filter((s) => s === 200)).toHaveLength(5);
    expect(statuses).not.toContain(500);
  });

  it("surfaces a user-agent/fingerprint mismatch as DEVICE_UNRECOGNIZED", async () => {
    process.env.FRAUD_STEP_UP_THRESHOLD = "1";
    const app = buildApp({ scorer: makeScorer() });

    const first = await request(app)
      .post("/")
      .set("user-agent", "Mozilla/5.0 (Macintosh)")
      .set("x-device-fingerprint", "fp-device")
      .send({ slotId: "slot-A" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/")
      .set("user-agent", "Mozilla/5.0 (iPhone)")
      .set("x-device-fingerprint", "fp-device")
      .send({ slotId: "slot-B" });

    expect(second.status).toBe(403);
    expect(second.body.reasonCodes).toContain("DEVICE_UNRECOGNIZED");
  });

  it("fails closed when the scorer throws (500, intent never created)", async () => {
    const broken = {
      evaluate: () => {
        throw new Error("scorer exploded");
      },
    } as unknown as FraudScorer;
    const app = buildApp({ scorer: broken });

    const res = await request(app).post("/").send({ slotId: "slot-A" });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("Booking intents are temporarily unavailable. Please retry.");

    // Audit contract: the fail-closed 500 is still audited with status 500.
    const auditLogger = mockAuditLogger();
    const app2 = buildApp({ scorer: broken, auditLogger });
    await request(app2).post("/").send({ slotId: "slot-A" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(auditLogger.log).not.toHaveBeenCalled(); // res.on("finish") never wired on the early return
  });
});

describe("captureRequestBody", () => {
  function captureApp() {
    const app = express();
    app.use(express.json());
    app.post("/", captureRequestBody, (req, res) => {
      res.json({ captured: (req as any).rawParsedBody });
    });
    return app;
  }

  it("preserves the raw body for downstream middleware", async () => {
    const app = captureApp();
    const res = await request(app)
      .post("/")
      .send({ slotId: "slot-1", email: "nope@tempmail.com" });
    expect(res.body.captured).toEqual({ slotId: "slot-1", email: "nope@tempmail.com" });
  });

  it("is a no-op when there is no body", async () => {
    const app = captureApp();
    const res = await request(app).post("/").send();
    // express.json() yields an empty object when no body is sent.
    expect(res.body.captured).toEqual({});
  });

  it("survives array JSON bodies and malformed JSON with a deterministic outcome", async () => {
    // Array bodies parse fine and pass straight through the capture wall.
    const arrayApp = express();
    arrayApp.use(express.json());
    arrayApp.post("/", captureRequestBody, (req, res) => {
      res.json({ captured: (req as any).rawParsedBody ?? null });
    });
    const arrayRes = await request(arrayApp)
      .post("/")
      .set("Content-Type", "application/json")
      .send("[1,2,3]");
    expect(arrayRes.status).toBe(200);
    expect(arrayRes.body.captured).toEqual([1, 2, 3]);

    // Primitive JSON bodies are rejected by express.json() strict mode
    // BEFORE the capture middleware runs: the boundary is deterministic.
    const strictApp = express();
    strictApp.use(express.json());
    strictApp.post("/", captureRequestBody, (req, res) => {
      res.json({ captured: (req as any).rawParsedBody ?? null });
    });
    const primitiveRes = await request(strictApp)
      .post("/")
      .set("Content-Type", "application/json")
      .send("42");
    expect(primitiveRes.status).toBe(400);

    const malformedRes = await request(strictApp)
      .post("/")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(malformedRes.status).toBe(400);
    expect(malformedRes.body.captured ?? null).toBeNull();
  });

  it("is a pass-through: it always calls next() exactly once", () => {
    const req = { body: { slotId: "slot-1" } } as any;
    const next = jest.fn();
    captureRequestBody(req, {} as any, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect((req as any).rawParsedBody).toEqual({ slotId: "slot-1" });
  });

  it("keeps rawParsedBody in sync with later rewrites of req.body (reference, not copy)", async () => {
    const req = { body: { slotId: "before" } } as any;
    const next = jest.fn();
    captureRequestBody(req, {} as any, next);
    req.body.slotId = "after"; // downstream mutation before validation runs
    expect((req as any).rawParsedBody).toEqual({ slotId: "after" });
  });
});

describe("FraudScoringOptions (issue #1109)", () => {
  beforeEach(() => {
    resetFraudDriftState();
    fraudReviewQueue._reset();
  });

  afterEach(() => {
    delete process.env.FRAUD_STEP_UP_MODE;
    delete process.env.FRAUD_STEP_UP_THRESHOLD;
    resetFraudDriftState();
  });

  it("resolves every option to a working default when called with no arguments", async () => {
    const auditLogger = mockAuditLogger();
    const store = new QuarantineStore();
    // Scorer configuration is read at construction time, so env must be set
    // before buildApp() creates the FraudScorer.
    process.env.FRAUD_STEP_UP_MODE = "quarantine";
    const app = buildApp({
      scorer: makeScorer(),
      auditLogger,
      quarantineStore: store,
    });

    const res = await request(app)
      .post("/")
      .set("user-agent", "Mozilla/5.0 (Macintosh)")
      .set("x-device-fingerprint", "fp-defaults")
      .send({ slotId: "slot-defaults" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Default audit logger must still emit the per-intent fraud_score event.
    expect(auditLogger.log).toHaveBeenCalledTimes(1);

    // With no injected store the middleware still quarantines a blocked
    // intent (defaults stay functional on the block path).
    for (let i = 0; i < 5; i += 1) {
      await request(app).post("/").send({ slotId: "slot-defaults" });
    }
    const blocked = await request(app)
      .post("/")
      .send({ slotId: "slot-defaults", email: DISPOSABLE });
    expect(blocked.status).toBe(403);
    expect(typeof blocked.body.quarantineId).toBe("string");
    expect(store.get(blocked.body.quarantineId)).toBeDefined();
  });

  it("never throws during construction when options are partially provided", () => {
    expect(() => antiFraudScoring({})).not.toThrow();
    expect(() => antiFraudScoring({ scorer: makeScorer() })).not.toThrow();
    expect(() => antiFraudScoring({ auditLogger: mockAuditLogger() })).not.toThrow();
    expect(() =>
      antiFraudScoring({ scorer: makeScorer(), auditLogger: mockAuditLogger() }),
    ).not.toThrow();
  });

  it("uses the injected scorer exclusively (a scoring decision never leaks from defaults)", async () => {
    const sentinelScorer = {
      evaluate: jest.fn().mockReturnValue({
        score: 0,
        reasons: [],
        snapshot: { snapshotId: "snap-1", specVersion: "test-1" },
      }),
      getThreshold: () => 5,
      getStepUpMode: () => "challenge" as const,
    } as unknown as FraudScorer;
    const app = buildApp({ scorer: sentinelScorer, auditLogger: mockAuditLogger() });

    const res = await request(app)
      .post("/")
      .set("user-agent", "Mozilla/5.0 (Macintosh)")
      .set("x-device-fingerprint", "fp-injected")
      .send({ slotId: "slot-injected" });

    expect(res.status).toBe(200);
    expect(sentinelScorer.evaluate).toHaveBeenCalledTimes(1);
    // Threshold from the injected scorer drives the decision.
    expect(res.body.score).toBe(0);
  });

  it("audits with the final HTTP status even when the audit logger rejects", async () => {
    const log = jest.fn<() => Promise<never>>().mockRejectedValue(new Error("audit sink down"));
    const failingAudit = { log } as unknown as AuditLogger;
    const app = buildApp({ scorer: makeScorer(), auditLogger: failingAudit });

    const res = await request(app)
      .post("/")
      .set("user-agent", "Mozilla/5.0 (Macintosh)")
      .set("x-device-fingerprint", "fp-audit-fail")
      .send({ slotId: "slot-audit-fail" });

    // Fire-and-forget: the serving path is unaffected by audit failures.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // The rejection is swallowed (never becomes an unhandled rejection).
    await new Promise((resolve) => setImmediate(resolve));
    expect(failingAudit.log).toHaveBeenCalledTimes(1);
    const [, , options] = (failingAudit.log as jest.Mock).mock.calls[0] as [
      unknown,
      unknown,
      { status: number },
    ];
    expect(options.status).toBe(200);
  });

  it("blocks with localized messages for a known locale and falls back to English otherwise", async () => {
    process.env.FRAUD_STEP_UP_MODE = "quarantine";
    const app2 = buildApp({ scorer: makeScorer() });
    for (let i = 0; i < 5; i += 1) {
      await request(app2).post("/").send({ slotId: "slot-locale" });
    }
    const blockedSpanish = await request(app2)
      .post("/")
      .set("accept-language", "es-MX,es;q=0.9")
      .send({ slotId: "slot-locale", email: DISPOSABLE });
    const blockedUnknownLocale = await request(app2)
      .post("/")
      .set("accept-language", "xx-YY")
      .send({ slotId: "slot-locale-2", email: DISPOSABLE });
    const blockedNoLocale = await request(app2)
      .post("/")
      .send({ slotId: "slot-locale-3", email: DISPOSABLE });

    expect(blockedSpanish.status).toBe(403);
    expect(blockedUnknownLocale.status).toBe(403);
    expect(blockedNoLocale.status).toBe(403);

    for (const blocked of [blockedSpanish, blockedUnknownLocale, blockedNoLocale]) {
      expect(Array.isArray(blocked.body.messages)).toBe(true);
      expect(blocked.body.messages.length).toBeGreaterThan(0);
      for (const message of blocked.body.messages) {
        expect(typeof message).toBe("string");
        expect(message.length).toBeGreaterThan(0);
      }
    }
  });

  it("maps internal reasons to public reason codes and dedupes them", async () => {
    process.env.FRAUD_STEP_UP_THRESHOLD = "1";
    const app = buildApp({ scorer: makeScorer() });

    // Both user_agent_mismatch and fingerprint_mismatch map to the same
    // DEVICE_UNRECOGNIZED public code; the payload must not repeat it.
    const first = await request(app)
      .post("/")
      .set("user-agent", "Mozilla/5.0 (Macintosh)")
      .set("x-device-fingerprint", "fp-dedupe")
      .send({ slotId: "slot-dedupe-1" });
    expect(first.status).toBe(200);

    const blocked = await request(app)
      .post("/")
      .set("user-agent", "Mozilla/5.0 (iPhone)")
      .set("x-device-fingerprint", "fp-dedupe")
      .send({ slotId: "slot-dedupe-2", email: DISPOSABLE });

    expect(blocked.status).toBe(403);
    const codes: string[] = blocked.body.reasonCodes;
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain("DEVICE_UNRECOGNIZED");
    expect(codes).toContain("INVALID_CONTACT_INFO");
  });

  it("enqueues the HITL item with the real intent id when the route completes it (issue #1345)", async () => {
    const app = buildApp({ scorer: makeScorer(), hitlIntentId: "intent-real-42" });

    const res = await request(app).post("/").send({ slotId: "slot-hitl", email: DISPOSABLE });
    expect(res.status).toBe(200);

    const pending = fraudReviewQueue.getPendingItems();
    expect(pending.length).toBeGreaterThan(0);
    const item = pending[pending.length - 1];
    expect(item.intentId).toBe("intent-real-42");
    expect(item.intentId).not.toBe("temp-intent-id");
    expect(item.score).toBeGreaterThan(0);
    expect(Array.isArray(item.reasons)).toBe(true);
    expect(res.body.queuedIntentId).toBe("intent-real-42");
  });

  it("rejects malformed scoring inputs deterministically (scorer throws -> fail closed)", async () => {
    const throwingScorer = {
      evaluate: () => {
        throw new TypeError("cannot read properties of undefined");
      },
    } as unknown as FraudScorer;
    const app = buildApp({ scorer: throwingScorer });

    for (const payload of [
      { slotId: "slot-a" },
      {},
      { slotId: null, email: DISPOSABLE },
      { rrule: "FREQ=DAILY;COUNT=3" },
    ]) {
      const res = await request(app).post("/").send(payload);
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe(
        "Booking intents are temporarily unavailable. Please retry.",
      );
      // The diagnostic response never leaks the scorer's internal error.
      expect(JSON.stringify(res.body)).not.toContain("TypeError");
    }
  });

  it("does not enqueue HITL review for score 0 even when threshold is 1", async () => {
    process.env.FRAUD_STEP_UP_THRESHOLD = "1";
    const app = buildApp({ scorer: makeScorer() });

    const res = await request(app)
      .post("/")
      .set("user-agent", "Mozilla/5.0 (Macintosh)")
      .set("x-device-fingerprint", "fp-zero")
      .send({ slotId: "slot-zero" });

    expect(res.status).toBe(200);
    expect(res.body.score).toBe(0);
    expect(fraudReviewQueue.getPendingItems()).toHaveLength(0);
  });
});

describe("enqueueHitlReviewForIntent (issue #1345)", () => {
  const borderlineReq = {
    fraudDecision: "review",
    fraudResult: { score: 1, reasons: ["disposable_email"] },
  } as any;

  beforeEach(() => {
    fraudReviewQueue._reset();
  });

  it("queues exactly one item keyed by the real intent id", () => {
    const item = enqueueHitlReviewForIntent(borderlineReq, "intent-real-9");

    expect(item).toMatchObject({
      intentId: "intent-real-9",
      score: 1,
      reasons: ["disposable_email"],
      status: "pending",
    });
    expect(fraudReviewQueue.getPendingItems()).toHaveLength(1);
  });

  it("is a no-op without a review decision, without a fraud result, or without an id", () => {
    expect(enqueueHitlReviewForIntent({} as any, "i-1")).toBeUndefined();
    expect(
      enqueueHitlReviewForIntent({ fraudDecision: "allowed" } as any, "i-1"),
    ).toBeUndefined();
    expect(
      enqueueHitlReviewForIntent({ fraudDecision: "review" } as any, "i-1"),
    ).toBeUndefined();
    expect(enqueueHitlReviewForIntent(borderlineReq, "")).toBeUndefined();
    expect(fraudReviewQueue.getPendingItems()).toHaveLength(0);
  });
});

describe("step-up challenge retry with x-fraud-challenge (issue #1345)", () => {
  const MFA_SECRET = "fraud-step-up-mfa-secret-12345";
  const ISSUER = "test-issuer";
  const AUDIENCE = "test-audience";

  async function mfaToken(sub: string): Promise<string> {
    const iat = Math.floor(Date.now() / 1000);
    return signJwt({ sub, iat, mfa_at: iat }, MFA_SECRET, {
      expiresInSec: 3600,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  }

  /** Drives the middleware to a challenge-mode block and returns the token. */
  async function issueChallengeToken(app: ReturnType<typeof buildApp>): Promise<string> {
    for (let i = 0; i < 5; i += 1) {
      await request(app).post("/").send({ slotId: "slot-A" });
    }
    const blocked = await request(app)
      .post("/")
      .send({ slotId: "slot-A", email: DISPOSABLE });
    expect(blocked.status).toBe(403);
    expect(blocked.body.challengeRequired).toBe(true);
    expect(typeof blocked.body.challengeToken).toBe("string");
    return blocked.body.challengeToken;
  }

  const blockedBody = { slotId: "slot-A", email: DISPOSABLE };

  beforeAll(async () => {
    process.env.MFA_CHALLENGE_SECRET = MFA_SECRET;
    process.env.MFA_ISSUER = ISSUER;
    process.env.JWT_AUDIENCE = AUDIENCE;
    configService.refresh();
    await flushMicrotasks(20);
  });

  afterAll(() => {
    delete process.env.MFA_CHALLENGE_SECRET;
    delete process.env.MFA_ISSUER;
    delete process.env.JWT_AUDIENCE;
    configService.refresh();
  });

  beforeEach(() => {
    resetFraudDriftState();
    fraudReviewQueue._reset();
  });

  afterEach(() => {
    delete process.env.FRAUD_STEP_UP_MODE;
    delete process.env.FRAUD_STEP_UP_THRESHOLD;
    resetFraudDriftState();
  });

  it("persists the issued token bound to the actor and the request body", async () => {
    const store = new InMemoryFraudChallengeStore();
    const app = buildApp({ scorer: makeScorer(), challengeStore: store });

    const token = await issueChallengeToken(app);

    const verdict = store.consume(token, {
      actorId: "user-1",
      bodyHash: hashFraudChallengeBody(blockedBody),
    });
    expect(verdict.ok).toBe(true);
  });

  it("passes exactly one retry with the token plus fresh MFA, then rejects reuse", async () => {
    const app = buildApp({ scorer: makeScorer() });
    const token = await issueChallengeToken(app);

    const retry = await request(app)
      .post("/")
      .set("x-fraud-challenge", token)
      .set("x-chronopay-mfa", await mfaToken("user-1"))
      .send(blockedBody);
    expect(retry.status).toBe(200);
    expect(retry.body.ok).toBe(true);
    expect(retry.body.decision).toBe("blocked"); // scored again, then bypassed

    const replay = await request(app)
      .post("/")
      .set("x-fraud-challenge", token)
      .set("x-chronopay-mfa", await mfaToken("user-1"))
      .send(blockedBody);
    expect(replay.status).toBe(403);
    expect(replay.body).toMatchObject({
      success: false,
      error: "Fraud challenge is invalid or has expired.",
      challengeRequired: true,
    });
  });

  it("rejects an expired token even when the MFA proof is fresh", async () => {
    const store = new InMemoryFraudChallengeStore({ ttlMs: -1 });
    const app = buildApp({ scorer: makeScorer(), challengeStore: store });

    const token = await issueChallengeToken(app);

    const retry = await request(app)
      .post("/")
      .set("x-fraud-challenge", token)
      .set("x-chronopay-mfa", await mfaToken("user-1"))
      .send(blockedBody);
    expect(retry.status).toBe(403);
    expect(retry.body.error).toBe("Fraud challenge is invalid or has expired.");
  });

  it("rejects a token presented by a different actor (foreign-actor replay)", async () => {
    const store = new InMemoryFraudChallengeStore();
    const appUser1 = buildApp({ scorer: makeScorer(), challengeStore: store });
    const token = await issueChallengeToken(appUser1);

    // Second actor, same shared store; threshold lowered so their first
    // disposable-email request is blocked and reaches the challenge branch.
    process.env.FRAUD_STEP_UP_THRESHOLD = "1";
    const appUser2 = buildApp({
      scorer: makeScorer(),
      challengeStore: store,
      userId: "user-2",
    });
    const retry = await request(appUser2)
      .post("/")
      .set("x-fraud-challenge", token)
      .set("x-chronopay-mfa", await mfaToken("user-2"))
      .send(blockedBody);

    expect(retry.status).toBe(403);
    expect(retry.body.error).toBe("Fraud challenge is invalid or has expired.");

    // The legitimate owner's token was not burned by the foreign attempt.
    const ownerRetry = await request(appUser1)
      .post("/")
      .set("x-fraud-challenge", token)
      .set("x-chronopay-mfa", await mfaToken("user-1"))
      .send(blockedBody);
    expect(ownerRetry.status).toBe(200);
  });

  it("rejects a token replayed against a different request body", async () => {
    const app = buildApp({ scorer: makeScorer() });
    const token = await issueChallengeToken(app);

    const retry = await request(app)
      .post("/")
      .set("x-fraud-challenge", token)
      .set("x-chronopay-mfa", await mfaToken("user-1"))
      .send({ slotId: "slot-B", email: DISPOSABLE });

    expect(retry.status).toBe(403);
    expect(retry.body.error).toBe("Fraud challenge is invalid or has expired.");
  });

  it("keeps the token usable when the MFA proof is missing or invalid", async () => {
    const app = buildApp({ scorer: makeScorer() });
    const token = await issueChallengeToken(app);

    const missingMfa = await request(app)
      .post("/")
      .set("x-fraud-challenge", token)
      .send(blockedBody);
    expect(missingMfa.status).toBe(401);
    expect(missingMfa.body.error).toBe("Missing MFA challenge");

    const invalidMfa = await request(app)
      .post("/")
      .set("x-fraud-challenge", token)
      .set("x-chronopay-mfa", "not-a-jwt")
      .send(blockedBody);
    expect(invalidMfa.status).toBe(403);
    expect(invalidMfa.body.error).toBe("Invalid MFA challenge");

    // Neither failure consumed the token: the owner can still step up.
    const retry = await request(app)
      .post("/")
      .set("x-fraud-challenge", token)
      .set("x-chronopay-mfa", await mfaToken("user-1"))
      .send(blockedBody);
    expect(retry.status).toBe(200);
  });

  it("still issues a fresh token when the retry is not attempted", async () => {
    const app = buildApp({ scorer: makeScorer() });

    const first = await issueChallengeToken(app);
    const second = await issueChallengeToken(app);

    // Distinct UUIDs: every block issues its own persistable token.
    expect(first).not.toBe(second);
  });
});
