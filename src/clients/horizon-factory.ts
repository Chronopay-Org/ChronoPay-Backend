import { loadEnvConfig, HorizonMode } from "../config/env.js";
import { ContractService } from "../services/contract.service.js";
import { HorizonContractClient } from "./horizon-contract-client.js";
import { HorizonLedgerFixture } from "../tests/fixtures/horizonLedger.js";

export type HorizonClient = HorizonContractClient | HorizonLedgerFixture;

export function createHorizonClient(mode?: HorizonMode): HorizonClient {
  const resolvedMode: HorizonMode = mode ?? parseHorizonModeFromEnv();
  if (resolvedMode === "fixture") {
    return new HorizonLedgerFixture();
  }
  const env = loadEnvConfig(process.env);
  const contractService = new ContractService();
  return new HorizonContractClient(
    env.horizonUrl ?? "https://horizon-testnet.stellar.org",
    env.networkPassphrase ?? "Test SDF Network ; September 2015",
    contractService,
  );
}

function parseHorizonModeFromEnv(): HorizonMode {
  const raw = process.env.HORIZON_MODE;
  if (raw === undefined) return "live";
  const val = raw.trim().toLowerCase();
  if (val === "fixture") return "fixture";
  return "live";
}
