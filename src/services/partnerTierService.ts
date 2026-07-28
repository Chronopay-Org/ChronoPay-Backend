export const partnerTierService = {
  fetchPartnerTier: async (apiKeyId: string): Promise<string> => {
    if (apiKeyId.includes("premium")) return "premium";
    if (apiKeyId.includes("unlisted")) return "unlisted";
    return "basic";
  }
};
