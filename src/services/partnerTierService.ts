export const DEFAULT_PARTNER_TIER = "basic";

type PartnerTierMap = Record<string, string>;

function parsePartnerTierMap(raw: string | undefined): PartnerTierMap {
  if (raw === undefined || raw.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("PARTNER_API_KEY_TIERS must be valid JSON", { cause: error });
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PARTNER_API_KEY_TIERS must be a JSON object mapping API key IDs to tiers");
  }

  const mapping: PartnerTierMap = {};
  for (const [apiKeyId, tier] of Object.entries(parsed)) {
    if (!apiKeyId || typeof tier !== "string" || tier.trim() === "") {
      throw new Error("PARTNER_API_KEY_TIERS entries must map non-empty API key IDs to non-empty tier names");
    }
    mapping[apiKeyId] = tier;
  }
  return mapping;
}

let partnerTierMap = parsePartnerTierMap(process.env.PARTNER_API_KEY_TIERS);

export const partnerTierService = {
  fetchPartnerTier: async (apiKeyId: string): Promise<string> => {
    return partnerTierMap[apiKeyId] ?? DEFAULT_PARTNER_TIER;
  },
};

export function reloadPartnerTierMap(raw = process.env.PARTNER_API_KEY_TIERS): void {
  partnerTierMap = parsePartnerTierMap(raw);
}
