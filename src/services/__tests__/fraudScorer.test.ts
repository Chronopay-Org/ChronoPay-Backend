// @ts-nocheck
import { jest } from "@jest/globals";
import { FraudScorer } from "../fraudScorer.js";
import {
  FraudReasonCode,
  getFraudReasonCode,
} from "../fraudReasonCodes.js";

function createRequest(actorId: string, ip: string, fingerprint: string, tenantId = "tenant-alpha") {
  return {
    auth: {
      userId: actorId,
      fingerprint,
    },
    body: {
      email: "user@example.com",
    },
    headers: {
      "x-device-fingerprint": fingerprint,
      "x-tenant-id": tenantId,
    },
    ip,
  } as any;
}

function requestWithUa(actorId: string, ip: string, fp: string, ua?: string) {
  const req = createRequest(actorId, ip, fp);
  if (ua !== undefined) {
    req.headers["user-agent"] = ua;
  }
  return req;
}

describe("FraudScorer", () => {
  it("does not flag unrelated requests", () => {
    const scorer = new FraudScorer();

    const result = scorer.evaluate("intent-1", createRequest("user-1", "203.0.113.10", "fp-unique"));

    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
    expect(result.case).toBeUndefined();
  });

  describe("user-agent / device-fingerprint mismatch (issue #807)", () => {
    it("binds a fingerprint to its first-seen user-agent without flagging", () => {
      const scorer = new FraudScorer();
      const result = scorer.evaluate(
        "intent-1",
        requestWithUa("user-1", "198.51.100.1", "fp-ua-1", "Mozilla/5.0 (Macintosh)"),
      );
      expect(result.score).toBe(0);
      expect(result.reasons).toEqual([]);
      expect(result.snapshot?.features.userAgent).toBe("mozilla/5.0 (macintosh)");
      expect(result.snapshot?.features.userAgentMismatch).toBe(false);
    });

    it("flags the same fingerprint arriving with a different user-agent", () => {
      const scorer = new FraudScorer();
      scorer.evaluate(
        "intent-1",
        requestWithUa("user-1", "198.51.100.1", "fp-ua-2", "Mozilla/5.0 (Macintosh)"),
      );
      const result = scorer.evaluate(
        "intent-2",
        requestWithUa("user-1", "198.51.100.1", "fp-ua-2", "Mozilla/5.0 (iPhone)"),
      );
      expect(result.reasons).toContain("user_agent_mismatch");
      expect(result.snapshot?.features.userAgentMismatch).toBe(true);
    });

    it("is case-insensitive and trim-normalized", () => {
      const scorer = new FraudScorer();
      scorer.evaluate(
        "intent-1",
        requestWithUa("user-1", "198.51.100.2", "fp-ua-3", "  Mozilla/5.0 (X11; UBUNTU) "),
      );
      const result = scorer.evaluate(
        "intent-2",
        requestWithUa("user-1", "198.51.100.2", "fp-ua-3", "mozilla/5.0 (x11; ubuntu)"),
      );
      expect(result.score).toBe(0);
      expect(result.reasons).not.toContain("user_agent_mismatch");
    });

    it("does not flag when the fingerprint or user-agent is missing", () => {
      const scorer = new FraudScorer();
      const noUa = scorer.evaluate("intent-1", createRequest("user-1", "198.51.100.3", "fp-ua-4"));
      expect(noUa.reasons).not.toContain("user_agent_mismatch");

      const noFp = scorer.evaluate(
        "intent-2",
        requestWithUa("user-2", "198.51.100.4", "fp-ua-5", "Mozilla/5.0"),
      );
      expect(noFp.reasons).not.toContain("user_agent_mismatch");
    });

    it("only compares against the binding for the same fingerprint", () => {
      const scorer = new FraudScorer();
      scorer.evaluate(
        "intent-1",
        requestWithUa("user-1", "198.51.100.5", "fp-ua-6", "Mozilla/5.0 (Macintosh)"),
      );
      const diffFp = scorer.evaluate(
        "intent-2",
        requestWithUa("user-1", "198.51.100.5", "fp-ua-7", "Mozilla/5.0 (iPhone)"),
      );
      expect(diffFp.reasons).not.toContain("user_agent_mismatch");
    });
  });

  describe("reason code mapping", () => {
    it("maps user_agent_mismatch to DEVICE_UNRECOGNIZED", () => {
      const scorer = new FraudScorer();
      scorer.evaluate(
        "intent-1",
        requestWithUa("user-1", "198.51.100.6", "fp-ua-8", "Mozilla/5.0 (Macintosh)"),
      );
      const result = scorer.evaluate(
        "intent-2",
        requestWithUa("user-1", "198.51.100.6", "fp-ua-8", "Mozilla/5.0 (iPhone)"),
      );
      expect(result.reasons).toContain("user_agent_mismatch");
      expect(getFraudReasonCode("user_agent_mismatch")).toBe(FraudReasonCode.DEVICE_UNRECOGNIZED);
    });
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

  describe("Feature-Store Snapshotting (Issue #452)", () => {
    it("generates feature snapshots with spec version and SHA-256 feature hash", async () => {
      const mockWriter = {
        writeSnapshot: jest.fn().mockResolvedValue(undefined),
      };

      const scorer = new FraudScorer(mockWriter, {
        specVersion: "v1.2.0",
        defaultSamplingRate: 1.0,
      });

      const result = scorer.evaluate(
        "intent-100",
        createRequest("user-100", "198.51.100.1", "fp-spec-test", "tenant-beta"),
      );

      expect(result.snapshot).toBeDefined();
      expect(result.snapshot?.specVersion).toBe("v1.2.0");
      expect(result.snapshot?.tenantId).toBe("tenant-beta");
      expect(result.snapshot?.intentId).toBe("intent-100");
      expect(result.snapshot?.featureHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.snapshot?.sampled).toBe(true);

      // Wait for async fanout
      await new Promise((r) => setTimeout(r, 10));

      expect(mockWriter.writeSnapshot).toHaveBeenCalledTimes(1);
      expect(mockWriter.writeSnapshot).toHaveBeenCalledWith(result.snapshot);
    });

    it("handles spec bump mid-request correctly", () => {
      const scorer = new FraudScorer(undefined, { specVersion: "v1.0.0" });

      const res1 = scorer.evaluate("intent-1", createRequest("u1", "10.0.0.1", "fp1"));
      expect(res1.snapshot?.specVersion).toBe("v1.0.0");

      scorer.setSpecVersion("v2.0.0");
      expect(scorer.getSpecVersion()).toBe("v2.0.0");

      const res2 = scorer.evaluate("intent-2", createRequest("u2", "10.0.0.2", "fp2"));
      expect(res2.snapshot?.specVersion).toBe("v2.0.0");
      expect(res2.snapshot?.featureHash).not.toBe(res1.snapshot?.featureHash);
    });

    it("respects per-tenant sampling rate knob (including zero sampling)", async () => {
      const mockWriter = {
        writeSnapshot: jest.fn().mockResolvedValue(undefined),
      };

      const scorer = new FraudScorer(mockWriter, { defaultSamplingRate: 1.0 });

      // Disable sampling for tenant-zero
      scorer.setTenantSamplingRate("tenant-zero", 0.0);
      expect(scorer.getTenantSamplingRate("tenant-zero")).toBe(0.0);

      const resZero = scorer.evaluate(
        "intent-zero",
        createRequest("u-zero", "10.0.0.3", "fp-zero", "tenant-zero"),
      );

      expect(resZero.snapshot?.sampled).toBe(false);

      await new Promise((r) => setTimeout(r, 10));
      expect(mockWriter.writeSnapshot).not.toHaveBeenCalled();

      // Tenant-active with sampling 1.0
      const resActive = scorer.evaluate(
        "intent-active",
        createRequest("u-active", "10.0.0.4", "fp-active", "tenant-active"),
      );

      expect(resActive.snapshot?.sampled).toBe(true);

      await new Promise((r) => setTimeout(r, 10));
      expect(mockWriter.writeSnapshot).toHaveBeenCalledTimes(1);
    });

    it("remains resilient when snapshot writer is down or throws error (non-blocking)", async () => {
      const failingWriter = {
        writeSnapshot: jest.fn().mockRejectedValue(new Error("Writer connection refused")),
      };

      const scorer = new FraudScorer(failingWriter, { defaultSamplingRate: 1.0 });

      // Evaluation should proceed without throwing error despite writer failure
      const result = scorer.evaluate(
        "intent-fail-test",
        createRequest("u-fail", "10.0.0.5", "fp-fail"),
      );

      expect(result.score).toBeDefined();

      await new Promise((r) => setTimeout(r, 10));
      expect(failingWriter.writeSnapshot).toHaveBeenCalledTimes(1);
    });
  });
});
