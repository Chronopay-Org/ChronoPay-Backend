import {
  FraudChallengeStore,
  hashRequestBody,
} from "../fraudChallengeStore.js";

describe("FraudChallengeStore (issue #1345)", () => {
  const ACTOR = "user-1";
  const BODY_HASH = hashRequestBody({ slotId: "slot-1" });

  let now = 0;
  let store: FraudChallengeStore;

  beforeEach(() => {
    now = 1_000_000;
    store = new FraudChallengeStore(() => now);
  });

  afterEach(() => {
    delete process.env.FRAUD_CHALLENGE_TTL_MS;
  });

  it("accepts a token for the actor and body it was issued for", () => {
    const { token } = store.issue(ACTOR, BODY_HASH);

    expect(store.check(token, ACTOR, BODY_HASH)).toBeNull();
  });

  it("consumes a token exactly once", () => {
    const { token } = store.issue(ACTOR, BODY_HASH);

    expect(store.consume(token)).toBe(true);
    expect(store.consume(token)).toBe(false);
    expect(store.check(token, ACTOR, BODY_HASH)).toBe("unknown");
  });

  it("rejects a token issued to a different actor", () => {
    const { token } = store.issue(ACTOR, BODY_HASH);

    expect(store.check(token, "user-2", BODY_HASH)).toBe("actor_mismatch");
  });

  it("rejects a token presented with a different request body", () => {
    const { token } = store.issue(ACTOR, BODY_HASH);

    expect(store.check(token, ACTOR, hashRequestBody({ slotId: "slot-2" }))).toBe(
      "body_mismatch",
    );
  });

  it("rejects a token after its TTL has elapsed", () => {
    process.env.FRAUD_CHALLENGE_TTL_MS = "60000";
    const { token, expiresAt } = store.issue(ACTOR, BODY_HASH);
    expect(expiresAt).toBe(now + 60000);

    now += 59999;
    expect(store.check(token, ACTOR, BODY_HASH)).toBeNull();

    now += 1;
    expect(store.check(token, ACTOR, BODY_HASH)).toBe("expired");
  });

  it("rejects an unknown token", () => {
    expect(store.check("not-a-real-token", ACTOR, BODY_HASH)).toBe("unknown");
  });

  it("issues unique tokens", () => {
    const tokens = new Set(
      Array.from({ length: 25 }, () => store.issue(ACTOR, BODY_HASH).token),
    );

    expect(tokens.size).toBe(25);
  });

  it("_reset clears every outstanding token", () => {
    const { token } = store.issue(ACTOR, BODY_HASH);

    store._reset();

    expect(store.check(token, ACTOR, BODY_HASH)).toBe("unknown");
  });
});

describe("hashRequestBody", () => {
  it("is stable across key order and nested objects", () => {
    expect(hashRequestBody({ a: 1, b: { c: 2, d: 3 } })).toBe(
      hashRequestBody({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it("ignores undefined properties the way JSON does", () => {
    expect(hashRequestBody({ a: 1, b: undefined })).toBe(hashRequestBody({ a: 1 }));
  });

  it("distinguishes different bodies", () => {
    expect(hashRequestBody({ slotId: "slot-1" })).not.toBe(
      hashRequestBody({ slotId: "slot-2" }),
    );
  });

  it("hashes a missing body deterministically", () => {
    expect(hashRequestBody(undefined)).toBe(hashRequestBody(null));
    expect(hashRequestBody(undefined)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("FraudChallengeStore TTL configuration", () => {
  afterEach(() => {
    delete process.env.FRAUD_CHALLENGE_TTL_MS;
  });

  it("falls back to the default TTL when the env is unset or invalid", () => {
    delete process.env.FRAUD_CHALLENGE_TTL_MS;
    const defaultStore = new FraudChallengeStore(() => 0);
    expect(defaultStore.issue("user-1", "hash").expiresAt).toBe(10 * 60 * 1000);

    process.env.FRAUD_CHALLENGE_TTL_MS = "not-a-number";
    const invalidStore = new FraudChallengeStore(() => 0);
    expect(invalidStore.issue("user-1", "hash").expiresAt).toBe(10 * 60 * 1000);

    process.env.FRAUD_CHALLENGE_TTL_MS = "-5";
    const negativeStore = new FraudChallengeStore(() => 0);
    expect(negativeStore.issue("user-1", "hash").expiresAt).toBe(10 * 60 * 1000);
  });
});
