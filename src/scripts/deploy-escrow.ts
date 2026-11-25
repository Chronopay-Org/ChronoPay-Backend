#!/usr/bin/env node
/**
 * deploy-escrow.ts
 *
 * One-time deployment script for the ChronoPay Soroban escrow contract.
 *
 * Usage (dry run, no network call):
 *   npx tsx src/scripts/deploy-escrow.ts --dry-run
 *
 * Usage (real deploy against testnet):
 *   SOROBAN_RPC_URL=https://soroban-testnet.stellar.org \
 *   STELLAR_SECRET_KEY=S... \
 *   NETWORK_PASSPHRASE="Test SDF Network ; September 2015" \
 *   CONTRACT_WASM_PATH=./escrow.wasm \
 *   npx tsx src/scripts/deploy-escrow.ts
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

import {
  Address,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
  type xdr,
} from "@stellar/stellar-sdk";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export interface DeployResult {
  contractAddress: string;
  wasmHash: string;
  txHash: string;
}

export type DeployRpcServer = Pick<
  rpc.Server,
  "getAccount" | "simulateTransaction" | "sendTransaction" | "pollTransaction"
>;

export interface DeployDependencies {
  env?: NodeJS.ProcessEnv;
  isDryRun?: boolean;
  keypair?: Keypair;
  server?: DeployRpcServer;
  createServer?: (rpcUrl: string) => DeployRpcServer;
  salt?: Uint8Array;
  pollAttempts?: number;
}

export interface RunDeployOptions {
  env?: NodeJS.ProcessEnv;
  isDryRun?: boolean;
  wasmPath?: string;
  deploy?: (
    wasmPath: string,
    dependencies?: DeployDependencies,
  ) => Promise<DeployResult>;
  writeLine?: (line: string, stream: "stdout" | "stderr") => void;
}

export interface RunDeployResult {
  exitCode: number;
  lines: string[];
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function validateRpcUrl(rpcUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new Error("Invalid SOROBAN_RPC_URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Invalid SOROBAN_RPC_URL");
  }
}

function readKeypair(secretKey: string): Keypair {
  try {
    return Keypair.fromSecret(secretKey);
  } catch {
    throw new Error("Invalid STELLAR_SECRET_KEY");
  }
}

function createRpcServer(rpcUrl: string): DeployRpcServer {
  const url = new URL(rpcUrl);
  return new rpc.Server(rpcUrl, { allowHttp: url.protocol === "http:" });
}

function redactSecret(message: string, secret: string | undefined): string {
  const value = secret?.trim();
  return value ? message.split(value).join("[REDACTED]") : message;
}

export function computeWasmHash(wasmPath: string): string {
  const buf = fs.readFileSync(wasmPath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function extractWasmHash(retval: xdr.ScVal | undefined): string {
  if (!retval || retval.type !== "scvBytes") {
    throw new Error("Upload simulation did not return a WASM hash");
  }
  return Buffer.from(retval.bytes.toBytes()).toString("hex");
}

function extractContractAddress(retval: xdr.ScVal | undefined): string {
  if (!retval || retval.type !== "scvAddress") {
    throw new Error("Deployment simulation did not return a contract address");
  }
  return Address.fromScVal(retval).toString();
}

async function submitHostFunction(
  server: DeployRpcServer,
  keypair: Keypair,
  networkPassphrase: string,
  operation: ReturnType<typeof Operation.uploadContractWasm>,
  label: string,
  pollAttempts: number,
  beforeSubmit?: (simulation: rpc.Api.SimulateTransactionSuccessResponse) => void,
): Promise<{ simulation: rpc.Api.SimulateTransactionSuccessResponse; txHash: string }> {
  const account = await server.getAccount(keypair.publicKey());
  const rawTransaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(180)
    .build();

  const simulation = await server.simulateTransaction(rawTransaction);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`${label} simulation failed: ${simulation.error}`);
  }
  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new Error(`${label} simulation failed`);
  }
  beforeSubmit?.(simulation);

  const preparedTransaction = rpc.assembleTransaction(rawTransaction, simulation).build();
  preparedTransaction.sign(keypair);

  const sent = await server.sendTransaction(preparedTransaction);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new Error(`${label} transaction rejected: ${sent.status}`);
  }

  const confirmed = await server.pollTransaction(sent.hash, {
    attempts: pollAttempts,
  });
  if (confirmed.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`${label} transaction ${confirmed.status.toLowerCase()}`);
  }

  return { simulation, txHash: confirmed.txHash || sent.hash };
}

export async function deployContract(
  wasmPath: string,
  dependencies: DeployDependencies = {},
): Promise<DeployResult> {
  const wasmHash = computeWasmHash(wasmPath);

  if (dependencies.isDryRun ?? process.argv.includes("--dry-run")) {
    const mockAddress = "C" + "0".repeat(55);
    const mockTxHash = "0".repeat(64);
    return { contractAddress: mockAddress, wasmHash, txHash: mockTxHash };
  }

  const env = dependencies.env ?? process.env;
  const rpcUrl = requireEnv(env, "SOROBAN_RPC_URL");
  const secretKey = requireEnv(env, "STELLAR_SECRET_KEY");
  const networkPassphrase = requireEnv(env, "NETWORK_PASSPHRASE");
  validateRpcUrl(rpcUrl);

  const keypair = dependencies.keypair ?? readKeypair(secretKey);
  const server =
    dependencies.server ??
    (dependencies.createServer ?? createRpcServer)(rpcUrl);
  const pollAttempts = dependencies.pollAttempts ?? 30;
  const salt = dependencies.salt ?? crypto.randomBytes(32);

  await submitHostFunction(
    server,
    keypair,
    networkPassphrase,
    Operation.uploadContractWasm({ wasm: fs.readFileSync(wasmPath) }),
    "WASM upload",
    pollAttempts,
    (simulation) => {
      const onChainHash = extractWasmHash(simulation.result?.retval);
      if (onChainHash.toLowerCase() !== wasmHash.toLowerCase()) {
        throw new Error(
          `WASM hash mismatch: local ${wasmHash}, on-chain ${onChainHash}`,
        );
      }
    },
  );

  const deploy = await submitHostFunction(
    server,
    keypair,
    networkPassphrase,
    Operation.createCustomContract({
      address: Address.fromString(keypair.publicKey()),
      wasmHash: Uint8Array.from(Buffer.from(wasmHash, "hex")),
      salt,
    }),
    "Contract deployment",
    pollAttempts,
  );

  const contractAddress = extractContractAddress(deploy.simulation.result?.retval);
  return { contractAddress, wasmHash, txHash: deploy.txHash };
}

export async function main(
  options: RunDeployOptions = {},
): Promise<RunDeployResult> {
  const isDryRun = options.isDryRun ?? process.argv.includes("--dry-run");
  const env = options.env ?? process.env;
  const wasmPath =
    options.wasmPath ??
    env.CONTRACT_WASM_PATH ??
    path.join(process.cwd(), "escrow.wasm");
  const deploy = options.deploy ?? deployContract;

  const finish = (
    exitCode: number,
    lines: string[],
    stream: "stdout" | "stderr",
  ): RunDeployResult => {
    if (options.writeLine) {
      for (const line of lines) {
        options.writeLine(line, stream);
      }
    }
    return { exitCode, lines };
  };

  if (!isDryRun && !fs.existsSync(wasmPath)) {
    return finish(1, [`WASM file not found: ${wasmPath}`], "stderr");
  }

  const resolvedPath =
    isDryRun && !fs.existsSync(wasmPath)
      ? (() => {
          const tmp = path.join(process.cwd(), ".tmp-escrow.wasm");
          fs.writeFileSync(tmp, Buffer.from("dry-run-placeholder"));
          return tmp;
        })()
      : wasmPath;

  try {
    const result = await deploy(resolvedPath, { env, isDryRun });
    const lines = [
      "",
      "=== ChronoPay Escrow Contract Deployed ===",
      `  Contract address : ${result.contractAddress}`,
      `  WASM hash        : ${result.wasmHash}`,
      `  Deploy tx hash   : ${result.txHash}`,
      "",
      "Next step: pin the WASM hash in your vault and set:",
      `  ESCROW_CONTRACT_HASH=${result.wasmHash}`,
    ];
    if (isDryRun) {
      lines.push("", "[DRY RUN — no transaction was submitted]");
    }
    return finish(0, lines, "stdout");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return finish(
      1,
      [`Deployment failed: ${redactSecret(message, env.STELLAR_SECRET_KEY)}`],
      "stderr",
    );
  } finally {
    const tmp = path.join(process.cwd(), ".tmp-escrow.wasm");
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main()
    .then(({ exitCode, lines }) => {
      const writer = exitCode === 0 ? console.log : console.error;
      for (const line of lines) {
        writer(line);
      }
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Deployment failed: ${redactSecret(message, process.env.STELLAR_SECRET_KEY)}`,
      );
      process.exit(1);
    });
}
