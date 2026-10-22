/**
 * Step-up challenge token flow (issue #1345).
 *
 * When the fraud wall blocks a request in challenge mode it now persists the
 * issued `challengeToken`. A retry presenting the token in `x-fraud-challenge`
 * *and* a fresh MFA proof in `x-chronopay-mfa` bypasses the block exactly once;
 * reuse, expiry, a foreign actor, a changed body, or a missing/invalid MFA
 * proof are all rejected.
 */

import express from "express";
import request from "supertest";
import { jest } from "@jest/globals";
import { FraudScorer } from "../../services/fraudScorer.js";
import { FraudChallengeStore, hashRequestBody } from "../../services/fraudChallengeStore.js";
import { fraudReviewQueue } from "../../services/fraudReviewQueue.js";
import { resetFraudDriftState } from "../../metrics/fraudDriftMetrics.js";
import { antiFraudScoring, captureRequestBody } from "../fraudScoring.js";
import { signJwt } from "../../utils/jwt.js";
import type { AuditLogger } from "../../services/auditLogger.js";

const DISPOSABLE = "customer@tempmail.com";
const MFA_SECRET = "fraud-challenge-mfa-secret-12345";
const ISSUER = "fraud-challenge-test-issuer";
const AUDIENCE = "fraud-challenge-test-audience";

/** A valid, fresh MFA proof for `sub`, as `POST /auth/mfa/verify` would issue. */
async function mfaToken(
  sub: string,
  options: { iatSec?: number; secret?: string } = {},
): Promise<string> {
  const iat = options.iatSec ?? Math.floor(Date.now() / 1000);
  return signJwt({ sub, iat, mfa_at: iat }, options.secret ?? MFA_SECRET, {
    expiresInSec: 3600,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

function buildApp(
  opts: {
    store: FraudChallengeStore;
    userId?: string;
    mfa?: Parameters<typeof antiFraudScoring>[0]["mfa"];
  },
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).auth = { userId: opts.userId ?? "user-1", role: "customer", claims: {} };
    next();
  });
  app.post(
    "/",
    captureRequestBody,
    antiFraudScoring({
      scorer: new FraudScorer(),
      auditLogger: { log: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) } as unknown as AuditLogger,
      challengeStore: opts.store,
      mfa: opts.mfa,
    }),
    (_req, res) => {
      res.status(200).json({ ok: true });
    },
  );
  return app;
}

const MFA_OPTIONS = { challengeSecret: MFA_SECRET, issuer: ISSUER, audience: AUDIENCE };

/** Drives velocity to the block, then returns the 403 + its challenge token. */
async function blockOnce(
  app: express.Express,
  body: Record<string, unknown> = { slotId: "slot-A", email: DISPOSABLE },
): Promise<{ status: number; token: string; res: request.Response }> {
  for (let i = 0; i < 5; i += 1) {
    await request(app).post("/").send({ slotId: "slot-A" });
  }
  const res = await request(app).post("/").send(body);
  return { status: res.status, token: res.body.challengeToken as string, res };
}

describe("antiFraudScoring challenge step-up (issue #1345)", () => {
  let store: FraudChallengeStore;
  let now: number;

  beforeEach(() => {
    resetFraudDriftState();
    fraudReviewQueue._reset();
    now = Date.now();
    store = new FraudChallengeStore(() => now);
    delete process.env.FRAUD_CHALLENGE_TTL_MS;
  });

  afterEach(() => {
    delete process.env.FRAUD_STEP_UP_MODE;
    delete process.env.FRAUD_STEP_UP_THRESHOLD;
    delete process.env.FRAUD_CHALLENGE_TTL_MS;
    resetFraudDriftState();
  });

  it("persists the issued challenge token bound to the blocked actor and request body", async () => {
    const app = buildApp({ store, mfa: MFA_OPTIONS });

    const { status, token, res } = await blockOnce(app);

    expect(status).toBe(403);
    expect(res.body.challengeRequired).toBe(true);
    expect(typeof token).toBe("string");

    // Stored, bound to this actor and this exact body — not floating free.
    const bodyHash = hashRequestBody({ slotId: "slot-A", email: DISPOSABLE });
    expect(store.check(token, "user-1", bodyHash)).toBeNull();
    expect(store.check(token, "user-2", bodyHash)).toBe("actor_mismatch");
    expect(store.check(token, "user-1", hashRequestBody({ slotId: "slot-B" }))).toBe(
      "body_mismatch",
    );
  });

  it("bypasses the block once with the token plus a fresh MFA proof, then rejects reuse", async () => {
    const app = buildApp({ store, mfa: MFA_OPTIONS });
    const { token } = await blockOnce(app);

    const mfa = await mfaToken("user-1");
    const retry = await request(app)
      .post("/")
      .set("x-fraud-challenge", token)
      .set("x-chronopay-mfa", mfa)
      .send({ slotId: "slot-A", email: DISPOSABLE });
    expect(retry.status).toBe(200);
    expect(retry.body.ok).toBe(true);

    // One-time: the successful solve consumed the token.
    const reuse = await request(app)
      .post("/")
      .set("x-fraud-challenge", token)
      .set("x-chronopay-mfa", await mfaToken("user-1"))
      .send({ slotId: "slot-A", email: DISPOSABLE });
    expect(reuse.status).toBe(403);
    expect(reuse.body.error).toBe("Fraud challenge token is not valid.");
  });

  it("rejects an expired token", async () => {
    process.env.FRAUD_CHALLENGE_TTL_MS = "60000";
    const app = buildApp({ store, mfa: MFA_OPTIONS });
    const { token } = await blockOnce(app);

    now += 60001;

    const retry = await request(app)
      .post("/")
      .set("x-fraud-challenge", token)
      .set("x-chronopay-mfa", await mfaToken("user-1"))
      .send({ slotId: "slot-A", email: DISPOSABLE });
    expect(retry.status).toBe(403);
    expect(retry.body.error).toBe(
      "Fraud challenge token has expired; please retry to obtain a new one.",
    );
  });

  it("rejects a token issued to a different actor", async () => {
    const issuerApp = buildApp({ store, mfa: MFA_OPTIONS });
    const { token } = await blockOnce(issuerApp);

    const otherActorApp = buildApp({ store, userId: "user-2", mfa: MFA_OPTIONS });
    const retry = await request(otherActorApp)
      .post("/")
      .set("x-fraud-challenge", token)
      .set("x-chronopay-mfa", await mfaToken("user-2"))
      .send({ slotId: "slot-A", email: DISPOSABLE });

    expect(retry.status).toBe(403);
    expect(retry.body.error).toBe("Fraud challenge token does not match this request.");
  });

  it("rejects a retry whose body differs from the blocked request", async () => {
    const app = buildApp({ store, mfa: MFA_OPTIONS });
    const { token } = await blockOnce(app);

    const retry = await request(app)
      .post("/")
      .set("x-fraud-challenge", token)
      .set("x-chronopay-mfa", await mfaToken("user-1"))
      .send({ slotId: "slot-A", email: "someone-else@example.com" });

    expect(retry.status).toBe(403);
    expect(retry.body.error).toBe("Fraud challenge token does not match this request.");
  });

  it("rejects a missing MFA proof without consuming the token", async () => {
    const app = buildApp({ store, mfa: MFA_OPTIONS });
    const { token } = await blockOnce(app);

    const noMfa = await request(app)
      .post("/")
      .set("x-fraud-challenge", token)
      .send({ slotId: "slot-A", email: DISPOSABLE });
    expect(noMfa.status).toBe(401);
    expect(noMfa.body.error).toBe("Missing MFA challenge");

    // Still redeemable: only a solved challenge consumes it.
    const solved = await request(app)
      .post("/")
      .set("x-fraud-challenge", token)
      .set("x-chronopay-mfa", await mfaToken("user-1"))
      .send({ slotId: "slot-A", email: DISPOSABLE });
    expect(solved.status).toBe(200);
  });

  it("rejects an invalid MFA proof and keeps the block in place", async () => {
    const app = buildApp({ store, mfa: MFA_OPTIONS });
    const { token } = await blockOnce(app);

    const badMfa = await request(app)
      .post("/")
      .set("x-fraud-challenge", token)
      .set("x-chronopay-mfa", "not-a-jwt")
      .send({ slotId: "slot-A", email: DISPOSABLE });
    expect(badMfa.status).toBe(403);
    expect(badMfa.body.error).toBe("Invalid MFA challenge");

    // An MFA proof bound to another actor is invalid for this request too.
    const foreignMfa = await request(app)
      .post("/")
      .set("x-fraud-challenge", token)
      .set("x-chronopay-mfa", await mfaToken("user-2"))
      .send({ slotId: "slot-A", email: DISPOSABLE });
    expect(foreignMfa.status).toBe(403);
    expect(foreignMfa.body.error).toBe("Invalid MFA challenge");
    expect(foreignMfa.body.challengeRequired).toBeUndefined();
  });

  it("ignores an unknown challenge token instead of trusting it", async () => {
    const app = buildApp({ store, mfa: MFA_OPTIONS });

    const res = await request(app)
      .post("/")
      .set("x-fraud-challenge", "00000000-0000-4000-8000-000000000000")
      .set("x-chronopay-mfa", await mfaToken("user-1"))
      .send({ slotId: "slot-A" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Fraud challenge token is not valid.");
  });

  it("still audits a bypassed request as allowed with its final status", async () => {
    const log = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).auth = { userId: "user-1", role: "customer", claims: {} };
      next();
    });
    app.post(
      "/",
      captureRequestBody,
      antiFraudScoring({
        scorer: new FraudScorer(),
        auditLogger: { log } as unknown as AuditLogger,
        challengeStore: store,
        mfa: MFA_OPTIONS,
      }),
      (_req, res) => res.status(201).json({ created: true }),
    );

    const { token } = await blockOnce(app);

    const retry = await request(app)
      .post("/")
      .set("x-fraud-challenge", token)
      .set("x-chronopay-mfa", await mfaToken("user-1"))
      .send({ slotId: "slot-A", email: DISPOSABLE });
    expect(retry.status).toBe(201);

    await new Promise((resolve) => setImmediate(resolve));
    // 5 clean + the original block + the bypassed retry, each audited once.
    expect(log).toHaveBeenCalledTimes(7);
    const bypassedCall = (log as unknown as jest.Mock).mock.calls.at(-1)!;
    expect((bypassedCall[1] as any).body.decision).toBe("allowed");
    expect((bypassedCall[2] as any).status).toBe(201);
  });
});
