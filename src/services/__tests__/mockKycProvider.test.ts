import { describe, it, expect } from "@jest/globals";
import { MockKycProvider } from "../mockKycProvider.js";
import { KycInvalidPayloadError } from "../kycProvider.js";

describe("MockKycProvider", () => {
  const provider = new MockKycProvider();

  it("parses a well-formed payload", () => {
    expect(
      provider.parseWebhook({ supplierId: "s1", kycRef: "ref-1", status: "verified" }),
    ).toEqual({ supplierId: "s1", kycRef: "ref-1", status: "verified" });
  });

  it("parses every allowed status", () => {
    for (const status of ["pending", "verified", "rejected", "under_review"]) {
      expect(provider.parseWebhook({ supplierId: "s1", kycRef: "ref-1", status }).status).toBe(
        status,
      );
    }
  });

  it("rejects missing required fields", () => {
    for (const body of [
      undefined,
      null,
      {},
      { supplierId: "s1" },
      { supplierId: "s1", kycRef: "ref-1" },
      { kycRef: "ref-1", status: "verified" },
      { supplierId: "s1", status: "verified" },
    ]) {
      expect(() => provider.parseWebhook(body)).toThrow(KycInvalidPayloadError);
    }
  });

  it("rejects an unknown status with a descriptive message", () => {
    expect(() =>
      provider.parseWebhook({ supplierId: "s1", kycRef: "ref-1", status: "invalid_status" }),
    ).toThrow("Invalid status: invalid_status");
  });

  it("rejects an over-long kycRef matching the DB column bound", () => {
    expect(() =>
      provider.parseWebhook({
        supplierId: "s1",
        kycRef: "x".repeat(256),
        status: "verified",
      }),
    ).toThrow(KycInvalidPayloadError);
  });

  it("trims whitespace around kycRef", () => {
    expect(
      provider.parseWebhook({
        supplierId: "s1",
        kycRef: "  ref-1  ",
        status: "pending",
      }).kycRef,
    ).toBe("ref-1");
  });

  it("coerces supplierId to a string", () => {
    expect(
      provider.parseWebhook({ supplierId: 42, kycRef: "ref-1", status: "pending" }).supplierId,
    ).toBe("42");
  });
});
