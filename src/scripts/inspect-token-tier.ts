import { deriveApiKeyId, readPartnerTiersConfig } from "../middleware/apiKeyAuth.js";
import { partnerTierService } from "../services/partnerTierService.js";

async function main() {
  const apiKey = process.argv[2];
  if (!apiKey) {
    console.error("Usage: npx ts-node src/scripts/inspect-token-tier.ts <api-key>");
    process.exit(1);
  }

  const apiKeyId = deriveApiKeyId(apiKey);
  console.log(`API Key ID: ${apiKeyId}`);

  const tier = await partnerTierService.fetchPartnerTier(apiKeyId);
  console.log(`Resolved Tier: ${tier}`);

  const config = readPartnerTiersConfig();
  const allowedEndpoints = config.tiers[tier] || [];

  if (allowedEndpoints.length === 0) {
    console.log(`\nEffective Allowlist: None (Deny All)`);
  } else {
    console.log(`\nEffective Allowlist:`);
    for (const endpoint of allowedEndpoints) {
      console.log(`  - ${endpoint}`);
    }
  }
}

main().catch(err => {
  console.error("Error inspecting token:", err);
  process.exit(1);
});
