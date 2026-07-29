// @ts-nocheck
import { jest } from "@jest/globals";
import { FraudScorer } from "../fraudScorer.js";

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
