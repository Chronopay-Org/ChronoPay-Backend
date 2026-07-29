#!/usr/bin/env node
/**
 * deploy-escrow.ts
 *
 * One-time deployment script for the ChronoPay Soroban escrow contract.
 *
 * Usage (dry run, no network call):
 *   npx ts-node src/scripts/deploy-escrow.ts --dry-run
 *
 * Usage (real deploy against testnet):
 *   SOROBAN_RPC_URL=https://soroban-testnet.stellar.org \
 *   STELLAR_SECRET_KEY=S... \
 *   CONTRACT_WASM_PATH=./escrow.wasm \
 *   npx ts-node src/scripts/deploy-escrow.ts
 *
 * After deployment the script prints the contract address and the WASM hash.
 * Pin the WASM hash in your environment as `ESCROW_CONTRACT_HASH` before
 * starting the application.
 *
 * ## Security notes
 *
 * - The deployer secret key is read from the environment; never hard-code it.
 * - The WASM hash must be captured from the deploy output and stored in a
 *   secure config vault (e.g. AWS Secrets Manager), then set as
 *   `ESCROW_CONTRACT_HASH` in each deployment environment.
 * - Re-deploying produces a new contract address; update all references.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

const isDryRun = process.argv.includes("--dry-run");

interface DeployResult {
  contractAddress: string;
  wasmHash: string;
  txHash: string;
}

/**
 * Compute the SHA-256 WASM hash from a local WASM file.
 * This mirrors the hash that the Soroban RPC returns from `getContractData`.
 */
function computeWasmHash(wasmPath: string): string {
  const buf = fs.readFileSync(wasmPath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Simulate or execute a Soroban contract deployment.
 *
 * In production replace the body of this function with the actual
 * `stellar-sdk` / `stellar-base` Soroban upload + deploy XDR flow.
 */
async function deployContract(wasmPath: string): Promise<DeployResult> {
  const wasmHash = computeWasmHash(wasmPath);

  if (isDryRun) {
    const mockAddress = "C" + "0".repeat(55);
    const mockTxHash = "0".repeat(64);
    return { contractAddress: mockAddress, wasmHash, txHash: mockTxHash };
  }

  // ── Production path ────────────────────────────────────────────────────────
  //
  // TODO: replace the stub below with a real Soroban SDK deployment:
  //
  //   import { SorobanRpc, Keypair, Networks } from '@stellar/stellar-sdk';
  //
  //   const rpcUrl = process.env.SOROBAN_RPC_URL!;
  //   const secretKey = process.env.STELLAR_SECRET_KEY!;
  //   const server = new SorobanRpc.Server(rpcUrl);
  //   const keypair = Keypair.fromSecret(secretKey);
  //
  //   1. Upload WASM via `server.uploadContractWasm(wasmBytes)`
  //   2. Deploy contract via `server.createContract(…)`
  //   3. Return the resulting contractAddress, wasmHash, and txHash.
  //
  throw new Error(
    "Production deploy not yet implemented. Run with --dry-run to test locally.",
  );
}

async function main(): Promise<void> {
  const wasmPath = process.env.CONTRACT_WASM_PATH ?? path.join(process.cwd(), "escrow.wasm");

  if (!isDryRun && !fs.existsSync(wasmPath)) {
    console.error(`WASM file not found: ${wasmPath}`);
    process.exit(1);
  }

  // For dry-run create a minimal placeholder so the hash function runs
  const resolvedPath =
    isDryRun && !fs.existsSync(wasmPath)
      ? (() => {
          const tmp = path.join(process.cwd(), ".tmp-escrow.wasm");
          fs.writeFileSync(tmp, Buffer.from("dry-run-placeholder"));
          return tmp;
        })()
      : wasmPath;

  try {
    const result = await deployContract(resolvedPath);

    console.log("\n=== ChronoPay Escrow Contract Deployed ===");
    console.log(`  Contract address : ${result.contractAddress}`);
    console.log(`  WASM hash        : ${result.wasmHash}`);
    console.log(`  Deploy tx hash   : ${result.txHash}`);
    console.log("\nNext step: pin the WASM hash in your vault and set:");
    console.log(`  ESCROW_CONTRACT_HASH=${result.wasmHash}`);

    if (isDryRun) {
      console.log("\n[DRY RUN — no transaction was submitted]");
    }
  } finally {
    // Clean up the temp file created during dry-run
    const tmp = path.join(process.cwd(), ".tmp-escrow.wasm");
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

main().catch((err) => {
  console.error("Deployment failed:", err);
  process.exit(1);
});
