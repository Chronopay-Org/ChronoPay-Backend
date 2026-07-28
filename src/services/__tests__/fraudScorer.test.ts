import { FraudScorer } from "../fraudScorer";

function createRequest(actorId: string, ip: string, fingerprint: string) {
  return {
    auth: {
      userId: actorId,
      fingerprint,
    },
    body: {},
    headers: {
      "x-device-fingerprint": fingerprint,
    },
    ip,
  } as any;
}

describe("FraudScorer", () => {
  it("does not flag unrelated requests", () => {
    const scorer = new FraudScorer();

    const result = scorer.evaluate("intent-1", createRequest("user-1", "203.0.113.10", "fp-unique"));

    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
    expect(result.case).toBeUndefined();
  });

  it("detects shared IP and fingerprint co-occurrence and creates a review case", () => {
    const scorer = new FraudScorer();

    scorer.evaluate("intent-1", createRequest("user-1", "203.0.113.20", "fp-shared"));
    const result = scorer.evaluate("intent-2", createRequest("user-2", "203.0.113.20", "fp-shared"));

    expect(result.score).toBeGreaterThanOrEqual(5);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("shared_ip"),
        expect.stringContaining("shared_fingerprint"),
      ]),
    );
    expect(result.case).toEqual(
      expect.objectContaining({
        type: "sockpuppet_review",
        actors: expect.arrayContaining(["user-1", "user-2"]),
      }),
    );
    expect(result.case?.evidence.fingerprintHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.case?.evidence.fingerprint).toBeUndefined();
  });
});
