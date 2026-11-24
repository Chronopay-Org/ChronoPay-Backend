import {
  deriveApiKeyId,
  readPartnerTiersConfig,
  type PartnerTiersConfig,
} from "../middleware/apiKeyAuth.js";
import { partnerTierService } from "../services/partnerTierService.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface InspectTokenTierResult {
  exitCode: number;
  lines: string[];
}

export interface InspectTokenTierDependencies {
  deriveApiKeyId?: (apiKey: string) => string;
  fetchPartnerTier?: (apiKeyId: string) => Promise<string>;
  readPartnerTiersConfig?: () => PartnerTiersConfig;
  writeLine?: (line: string, stream: "stdout" | "stderr") => void;
}

export async function inspectTokenTier(
  apiKey: string | undefined,
  dependencies: InspectTokenTierDependencies = {},
): Promise<InspectTokenTierResult> {
  const finish = (exitCode: number, lines: string[]): InspectTokenTierResult => {
    if (dependencies.writeLine) {
      const stream = exitCode === 0 ? "stdout" : "stderr";
      for (const line of lines) {
        dependencies.writeLine(line, stream);
      }
    }
    return { exitCode, lines };
  };

  if (!apiKey) {
    return finish(1, [
      "Usage: npx tsx src/scripts/inspect-token-tier.ts <api-key>",
    ]);
  }

  const deriveId = dependencies.deriveApiKeyId ?? deriveApiKeyId;
  const fetchTier =
    dependencies.fetchPartnerTier ??
    ((apiKeyId: string) => partnerTierService.fetchPartnerTier(apiKeyId));
  const readConfig =
    dependencies.readPartnerTiersConfig ?? readPartnerTiersConfig;

  try {
    const apiKeyId = deriveId(apiKey);
    const lines = [`API Key ID: ${apiKeyId}`];

    const tier = await fetchTier(apiKeyId);
    lines.push(`Resolved Tier: ${tier}`);

    const config = readConfig();
    const allowedEndpoints = config.tiers[tier] || [];

    if (allowedEndpoints.length === 0) {
      lines.push("", "Effective Allowlist: None (Deny All)");
    } else {
      lines.push("", "Effective Allowlist:");
      for (const endpoint of allowedEndpoints) {
        lines.push(`  - ${endpoint}`);
      }
    }

    return finish(0, lines);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error);
    return finish(1, [`Error inspecting token: ${message}`]);
  }
}

export const runInspectTokenTier = inspectTokenTier;

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  inspectTokenTier(process.argv[2])
    .then((result) => {
      const writer = result.exitCode === 0 ? console.log : console.error;
      for (const line of result.lines) {
        writer(line);
      }
      process.exit(result.exitCode);
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error(`Error inspecting token: ${message}`);
      process.exit(1);
    });
}
