import { describe, it, expect, afterEach } from "vitest";
import {
  DEFAULT_PARTNER_TIER,
  partnerTierService,
  reloadPartnerTierMap,
} from "../partnerTierService";

afterEach(() => {
  reloadPartnerTierMap(undefined);
});

describe("reloadPartnerTierMap parsing", () => {
  it("throws a JSON error for malformed input", () => {
    expect(() => reloadPartnerTierMap("{not json")).toThrow(
      "PARTNER_API_KEY_TIERS must be valid JSON",
    );
  });

  it("preserves the original parse error as cause", () => {
    try {
      reloadPartnerTierMap("{not json");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).cause).toBeInstanceOf(SyntaxError);
    }
  });

  it.each([
    ["array", "[]"],
    ["null", "null"],
    ["string", "\"basic\""],
    ["number", "42"],
    ["boolean", "true"],
  ])("throws the object-shape error for %s values", (_label, raw) => {
    expect(() => reloadPartnerTierMap(raw)).toThrow(
      "PARTNER_API_KEY_TIERS must be a JSON object mapping API key IDs to tiers",
    );
  });

  it("throws the entry error for a blank tier name", () => {
    expect(() => reloadPartnerTierMap(JSON.stringify({ key1: "   " }))).toThrow(
      "PARTNER_API_KEY_TIERS entries must map non-empty API key IDs to non-empty tier names",
    );
  });

  it("throws the entry error for a non-string tier", () => {
    expect(() => reloadPartnerTierMap(JSON.stringify({ key1: 5 }))).toThrow(
      "PARTNER_API_KEY_TIERS entries must map non-empty API key IDs to non-empty tier names",
    );
  });

  it("throws the entry error for an empty API key ID", () => {
    expect(() => reloadPartnerTierMap(JSON.stringify({ "": "gold" }))).toThrow(
      "PARTNER_API_KEY_TIERS entries must map non-empty API key IDs to non-empty tier names",
    );
  });
});

describe("reloadPartnerTierMap reset behaviour", () => {
  it.each([["undefined", undefined], ["blank", "   "]])(
    "resets to an empty map with default tier for %s input",
    async (_label, raw) => {
      reloadPartnerTierMap(JSON.stringify({ key1: "gold" }));
      reloadPartnerTierMap(raw);
      expect(await partnerTierService.fetchPartnerTier("key1")).toBe(
        DEFAULT_PARTNER_TIER,
      );
    },
  );
});

describe("partnerTierService.fetchPartnerTier", () => {
  it("returns the configured tier for a known API key", async () => {
    reloadPartnerTierMap(JSON.stringify({ key1: "gold" }));
    expect(await partnerTierService.fetchPartnerTier("key1")).toBe("gold");
  });

  it("falls back to the default tier for unknown API keys", async () => {
    reloadPartnerTierMap(JSON.stringify({ key1: "gold" }));
    expect(await partnerTierService.fetchPartnerTier("unknown")).toBe("basic");
  });

  it("uses \"basic\" as the default tier", () => {
    expect(DEFAULT_PARTNER_TIER).toBe("basic");
  });
});

describe("reloadPartnerTierMap atomicity", () => {
  it("keeps the previous map when a reload fails", async () => {
    reloadPartnerTierMap(JSON.stringify({ key1: "gold" }));
    expect(() => reloadPartnerTierMap("{bad")).toThrow();
    expect(await partnerTierService.fetchPartnerTier("key1")).toBe("gold");
  });

  it("keeps the previous map when an entry validation fails", async () => {
    reloadPartnerTierMap(JSON.stringify({ key1: "gold" }));
    expect(() =>
      reloadPartnerTierMap(JSON.stringify({ key2: "silver", key3: "" })),
    ).toThrow();
    expect(await partnerTierService.fetchPartnerTier("key1")).toBe("gold");
    expect(await partnerTierService.fetchPartnerTier("key2")).toBe("basic");
  });
});
