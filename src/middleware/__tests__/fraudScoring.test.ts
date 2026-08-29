import express from "express";
import request from "supertest";
import { jest } from "@jest/globals";
import { FraudScorer } from "../../services/fraudScorer.js";
import { antiFraudScoring, captureRequestBody } from "../fraudScoring.js";
import { getFraudDriftSnapshot, resetFraudDriftState } from "../../metrics/fraudDriftMetrics.js";
import { fraudReviewQueue } from "../../services/fraudReviewQueue.js";
import { QuarantineStore } from "../../services/quarantineStore.js";
import type { AuditLogger } from "../../services/auditLogger.js";

const DISPOSABLE = "customer@tempmail.com";

function buildApp(opts: {
  scorer: FraudScorer;
  auditLogger?: AuditLogger;
  quarantineStore?: QuarantineStore;
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).auth = { userId: "user-1", role: "customer", claims: {} };
    next();
  });
  app.post(
    "/",
    antiFraudScoring({
      scorer: opts.scorer,
      auditLogger: opts.auditLogger,
      quarantineStore: opts.quarantineStore,
    }),
    (req, res) => {
      res.status(200).json({
        ok: true,
        score: (req as any).fraudResult?.score,
        reasons: (req as any).fraudResult?.reasons,
      });
    },
  );
  return app;
}

function makeScorer(): FraudScorer {
  return new FraudScorer();
}

function mockAuditLogger(): AuditLogger {
  return { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditLogger;
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
    expect(res.body).toEqual({ ok: true, score: 0, reasons: [] });

    const snapshot = getFraudDriftSnapshot();
    expect(snapshot.liveTotals["vdefault"]).toBe(1);

    expect(auditLogger.log).toHaveBeenCalledTimes(1);
    const [action, data, options] = (auditLogger.log as jest.Mock).mock.calls[0];
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

  it("queues borderline scores (threshold - 1) for HITL review and still allows the intent", async () => {
    const app = buildApp({ scorer: makeScorer() });

    const res = await request(app).post("/").send({ email: DISPOSABLE });

    expect(res.status).toBe(200);
    expect(res.body.score).toBe(1);

    const pending = fraudReviewQueue.getPendingItems();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      score: 1,
      reasons: ["disposable_email"],
    });
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
});
