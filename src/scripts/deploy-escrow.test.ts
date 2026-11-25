import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import {
  Account,
  Address,
  Keypair,
  SorobanDataBuilder,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import fs from "fs";
import os from "os";
import path from "path";
import {
  computeWasmHash,
  deployContract,
  main,
  type DeployRpcServer,
} from "./deploy-escrow.js";

type HostFunctionOperation = {
  type: string;
  func: {
    type: string;
    wasm?: Uint8Array;
    createContractV2?: {
      executable: { wasmHash: { toBytes(): Uint8Array } };
    };
  };
};

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const RPC_URL = "https://soroban-testnet.stellar.org";

let tempDir: string;
let wasmPath: string;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-escrow-"));
  wasmPath = path.join(tempDir, "escrow.wasm");
  fs.writeFileSync(wasmPath, Buffer.from("mock escrow wasm bytes"));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeEnv(keypair: Keypair): NodeJS.ProcessEnv {
  return {
    SOROBAN_RPC_URL: RPC_URL,
    STELLAR_SECRET_KEY: keypair.secret(),
    NETWORK_PASSPHRASE,
  };
}

function successSimulation(
  retval: xdr.ScVal,
): rpc.Api.SimulateTransactionSuccessResponse {
  const transactionData = new SorobanDataBuilder()
    .setResources(100_000, 1_000, 1_000)
    .setResourceFee("100");
  return {
    id: "test",
    latestLedger: 100,
    events: [],
    _parsed: true,
    transactionData,
    minResourceFee: "100",
    result: { auth: [], retval },
  };
}

function errorSimulation(
  message: string,
): rpc.Api.SimulateTransactionErrorResponse {
  return {
    id: "test",
    latestLedger: 100,
    events: [],
    _parsed: true,
    error: message,
  };
}

function txHash(index: number): string {
  return `tx-hash-${index}`.padEnd(64, "0");
}

class StubRpcServer implements DeployRpcServer {
  readonly simulatedTransactions: Transaction[] = [];
  readonly sentTransactions: Transaction[] = [];
  readonly polledHashes: string[] = [];
  private readonly simulations: rpc.Api.SimulateTransactionResponse[];
  private readonly sendStatus: rpc.Api.SendTransactionStatus;
  private readonly pollStatus: rpc.Api.GetTransactionStatus;

  constructor(options: {
    simulations: rpc.Api.SimulateTransactionResponse[];
    sendStatus?: rpc.Api.SendTransactionStatus;
    pollStatus?: rpc.Api.GetTransactionStatus;
  }) {
    this.simulations = options.simulations;
    this.sendStatus = options.sendStatus ?? "PENDING";
    this.pollStatus =
      options.pollStatus ?? rpc.Api.GetTransactionStatus.SUCCESS;
  }

  async getAccount(address: string): Promise<Account> {
    return new Account(address, "100");
  }

  async simulateTransaction(
    transaction: Transaction,
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    this.simulatedTransactions.push(transaction);
    const response = this.simulations.shift();
    if (!response) {
      throw new Error("unexpected simulation call");
    }
    return response;
  }

  async sendTransaction(
    transaction: Transaction,
  ): Promise<rpc.Api.SendTransactionResponse> {
    this.sentTransactions.push(transaction);
    return {
      status: this.sendStatus,
      hash: txHash(this.sentTransactions.length),
      latestLedger: 100,
      latestLedgerCloseTime: 0,
    };
  }

  async pollTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    this.polledHashes.push(hash);
    return {
      status: this.pollStatus,
      txHash: hash,
      latestLedger: 101,
      latestLedgerCloseTime: 0,
      oldestLedger: 1,
      oldestLedgerCloseTime: 0,
    } as rpc.Api.GetTransactionResponse;
  }
}

describe("deployContract", () => {
  test("uploads the WASM, waits for confirmation, and deploys the contract", async () => {
    const keypair = Keypair.random();
    const localHash = computeWasmHash(wasmPath);
    const contractAddress = Address.contract(
      Buffer.alloc(32, 7),
    ).toString();
    const server = new StubRpcServer({
      simulations: [
        successSimulation(
          xdr.ScVal.scvBytes(Buffer.from(localHash, "hex")),
        ),
        successSimulation(Address.fromString(contractAddress).toScVal()),
      ],
    });

    const result = await deployContract(wasmPath, {
      env: makeEnv(keypair),
      keypair,
      server,
      salt: Buffer.alloc(32),
    });

    expect(result).toEqual({
      contractAddress,
      wasmHash: localHash,
      txHash: txHash(2),
    });
    expect(server.polledHashes).toEqual([txHash(1), txHash(2)]);
    expect(server.sentTransactions).toHaveLength(2);

    const uploadOperation = server.simulatedTransactions[0]!.operations[0] as
      unknown as HostFunctionOperation;
    expect(uploadOperation.func.type).toBe(
      "hostFunctionTypeUploadContractWasm",
    );
    expect(Buffer.from(uploadOperation.func.wasm!).toString("hex")).toBe(
      fs.readFileSync(wasmPath).toString("hex"),
    );

    const deployOperation = server.simulatedTransactions[1]!.operations[0] as
      unknown as HostFunctionOperation;
    expect(deployOperation.func.type).toBe("hostFunctionTypeCreateContractV2");
    expect(
      Buffer.from(
        deployOperation.func.createContractV2!.executable.wasmHash.toBytes(),
      ).toString("hex"),
    ).toBe(localHash);
  });

  test("validates required environment variables before creating an RPC server", async () => {
    const keypair = Keypair.random();
    let serverCreated = false;

    await expect(
      deployContract(wasmPath, {
        env: {
          SOROBAN_RPC_URL: RPC_URL,
          STELLAR_SECRET_KEY: keypair.secret(),
        },
        keypair,
        createServer: () => {
          serverCreated = true;
          throw new Error("unexpected server creation");
        },
      }),
    ).rejects.toThrow(
      "Missing required environment variable: NETWORK_PASSPHRASE",
    );
    expect(serverCreated).toBe(false);
  });

  test("fails when the upload simulation fails", async () => {
    const keypair = Keypair.random();
    const server = new StubRpcServer({
      simulations: [errorSimulation("host function rejected")],
    });

    await expect(
      deployContract(wasmPath, {
        env: makeEnv(keypair),
        keypair,
        server,
      }),
    ).rejects.toThrow("WASM upload simulation failed: host function rejected");
    expect(server.sentTransactions).toHaveLength(0);
    expect(server.simulatedTransactions).toHaveLength(1);
  });

  test("aborts with a non-zero exit code on WASM hash mismatch", async () => {
    const keypair = Keypair.random();
    const server = new StubRpcServer({
      simulations: [successSimulation(xdr.ScVal.scvBytes(Buffer.alloc(32, 1)))],
    });

    const result = await main({
      env: makeEnv(keypair),
      isDryRun: false,
      wasmPath,
      deploy: (wasmFilePath, dependencies) =>
        deployContract(wasmFilePath, { ...dependencies, keypair, server }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("WASM hash mismatch");
    expect(server.sentTransactions).toHaveLength(0);
    expect(server.simulatedTransactions).toHaveLength(1);
  });

  test("never prints the deployer secret", async () => {
    const keypair = Keypair.random();
    const secret = keypair.secret();

    const result = await main({
      env: makeEnv(keypair),
      isDryRun: false,
      wasmPath,
      deploy: async () => {
        throw new Error(`rpc rejected secret ${secret}`);
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).not.toContain(secret);
    expect(result.lines.join("\n")).toContain("[REDACTED]");
  });
});

describe("main dry run", () => {
  test("keeps the mock address, mock tx hash, and local WASM hash", async () => {
    const result = await main({
      env: {},
      isDryRun: true,
      wasmPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.lines).toContain(
      `  Contract address : C${"0".repeat(55)}`,
    );
    expect(result.lines).toContain(`  WASM hash        : ${computeWasmHash(wasmPath)}`);
    expect(result.lines).toContain(`  Deploy tx hash   : ${"0".repeat(64)}`);
    expect(result.lines).toContain(
      "[DRY RUN — no transaction was submitted]",
    );
  });
});
