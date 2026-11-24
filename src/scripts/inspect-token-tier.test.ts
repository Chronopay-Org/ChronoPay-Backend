import { describe, expect, test } from "@jest/globals";
import {
  inspectTokenTier,
  runInspectTokenTier,
} from "./inspect-token-tier.js";

describe("inspectTokenTier", () => {
  test("returns usage text and exit code 1 without an API key", async () => {
    const result = await inspectTokenTier(undefined);

    expect(result.exitCode).toBe(1);
    expect(result.lines).toEqual([
      "Usage: npx tsx src/scripts/inspect-token-tier.ts <api-key>",
    ]);
  });

  test("prints the resolved tier and effective allowlist", async () => {
    const result = await runInspectTokenTier("test-key", {
      deriveApiKeyId: () => "apiKey_test",
      fetchPartnerTier: async () => "premium",
      readPartnerTiersConfig: () => ({
        tiers: {
          premium: ["GET /api/v1/partner/quota", "*"],
        },
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.lines).toContain("API Key ID: apiKey_test");
    expect(result.lines).toContain("Resolved Tier: premium");
    expect(result.lines).toContain("  - GET /api/v1/partner/quota");
  });

  test("prints deny-all text for a tier with zero endpoints", async () => {
    const result = await inspectTokenTier("test-key", {
      deriveApiKeyId: () => "apiKey_empty",
      fetchPartnerTier: async () => "empty",
      readPartnerTiersConfig: () => ({
        tiers: {
          empty: [],
        },
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.lines).toContain("Effective Allowlist: None (Deny All)");
  });

  test("returns exit code 1 when tier inspection throws", async () => {
    const result = await inspectTokenTier("test-key", {
      fetchPartnerTier: async () => {
        throw new Error("tier lookup unavailable");
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("tier lookup unavailable");
  });
});
