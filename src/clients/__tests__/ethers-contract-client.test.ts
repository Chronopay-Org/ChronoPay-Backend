/**
 * Focused behavior suite for `EthersContractClient`
 * (`src/clients/ethers-contract-client.ts`, Issue #1016).
 *
 * This module had no direct fixture; it was only exercised indirectly through
 * higher-level services. The suite pins the adapter's own contract:
 *
 * - `call()` builds the read contract against the provider, forwards the method
 *   name and positional arguments verbatim, and pairs the result with the
 *   provider block number;
 * - `sendTransaction()` refuses to run without a signer (typed error), builds
 *   the contract against the signer, forwards `options` as the trailing
 *   argument, and returns a `wait()` that forwards its confirmation count;
 * - failures from the underlying method propagate unchanged and never leave a
 *   half-built result behind.
 *
 * `ethers` is replaced with a recording double and the outbound retry/timeout
 * wrapper is stubbed to run inline, so the assertions are deterministic and the
 * suite performs no network access. Because this package runs as ESM under
 * Jest, modules are stubbed with `jest.unstable_mockModule` before the dynamic
 * imports below.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";

/* ─── ethers double ─────────────────────────────────────────────────────── */

interface ContractRecord {
  address: string;
  abi: unknown;
  runner: unknown;
  methodName: string | null;
}

interface EthersState {
  contracts: ContractRecord[];
  calls: Array<{ method: string; args: unknown[] }>;
  impl: (...args: unknown[]) => unknown;
}

const mockEthersState: EthersState = {
  contracts: [],
  calls: [],
  impl: async () => "ok",
};

jest.unstable_mockModule("ethers", () => {
  class Contract {
    address: string;
    abi: unknown;
    runner: unknown;
    methodName: string | null = null;

    constructor(address: string, abi: unknown, runner: unknown) {
      this.address = address;
      this.abi = abi;
      this.runner = runner;
      mockEthersState.contracts.push(this);
    }

    getFunction(name: string) {
      this.methodName = name;
      return (...args: unknown[]) => {
        mockEthersState.calls.push({ method: name, args });
        return mockEthersState.impl(...args);
      };
    }
  }

  return { ethers: { Contract } };
});

jest.unstable_mockModule("../../utils/outbound-helper.js", () => ({
  withTimeout: (fn: (signal: AbortSignal) => unknown) => fn(new AbortController().signal),
  withRetry: (fn: (attempt: number) => unknown) => fn(1),
}));

/* ─── imports after stubbing ────────────────────────────────────────────── */

const { EthersContractClient } = await import("../ethers-contract-client.js");
const { ContractInvalidRequestError } = await import("../../errors/contractErrors.js");
type ContractService = import("../../services/contract.service.js").ContractService;
type ContractInteractionArgs = import("../types.js").ContractInteractionArgs;

/* ─── helpers ───────────────────────────────────────────────────────────── */

function makeProvider(blockNumber = 42) {
  return { getBlockNumber: jest.fn(async () => blockNumber) };
}

function makeClient(options: { signer?: unknown; blockNumber?: number } = {}) {
  const provider = makeProvider(options.blockNumber);
  const service = {} as unknown as ContractService;
  const client = new EthersContractClient(provider as never, service, options.signer as never);
  return { client, provider, signer: options.signer };
}

function args(overrides: Partial<ContractInteractionArgs> = {}): ContractInteractionArgs {
  return {
    address: "0xabc",
    abi: [{ name: "balanceOf", type: "function" }],
    method: "balanceOf",
    args: ["0xdead"],
    ...overrides,
  };
}

beforeEach(() => {
  mockEthersState.contracts.length = 0;
  mockEthersState.calls.length = 0;
  mockEthersState.impl = async () => "ok";
});

/* ─── call() ────────────────────────────────────────────────────────────── */

describe("EthersContractClient.call()", () => {
  it("builds the read contract against the provider with the supplied address and abi", async () => {
    const { client, provider } = makeClient();
    await client.call(args());

    expect(mockEthersState.contracts).toHaveLength(1);
    expect(mockEthersState.contracts[0]).toMatchObject({ address: "0xabc" });
    expect(mockEthersState.contracts[0].abi).toEqual([{ name: "balanceOf", type: "function" }]);
    expect(mockEthersState.contracts[0].runner).toBe(provider);
  });

  it("resolves the named method and forwards its positional arguments", async () => {
    const { client } = makeClient();
    await client.call(args({ method: "transferFrom", args: ["0x1", "0x2", 7n] }));

    expect(mockEthersState.contracts[0].methodName).toBe("transferFrom");
    expect(mockEthersState.calls).toEqual([
      { method: "transferFrom", args: ["0x1", "0x2", 7n] },
    ]);
  });

  it("returns the method result paired with the provider block number", async () => {
    mockEthersState.impl = async () => 123n;
    const { client, provider } = makeClient({ blockNumber: 555 });

    const result = await client.call<bigint>(args());

    expect(result).toEqual({ data: 123n, blockNumber: 555 });
    expect(provider.getBlockNumber).toHaveBeenCalledTimes(1);
  });

  it("preserves a block number of zero", async () => {
    const { client } = makeClient({ blockNumber: 0 });
    const result = await client.call(args());
    expect(result.blockNumber).toBe(0);
  });

  it("works with a method that takes no arguments", async () => {
    mockEthersState.impl = async () => "totalSupply";
    const { client } = makeClient();
    const result = await client.call(args({ method: "totalSupply", args: [] }));
    expect(result.data).toBe("totalSupply");
    expect(mockEthersState.calls[0].args).toEqual([]);
  });

  it("does not forward options to a read-only method", async () => {
    const { client } = makeClient();
    await client.call(args({ options: { gasLimit: 1n } }));
    expect(mockEthersState.calls[0].args).toEqual(["0xdead"]);
  });

  it("propagates a method failure and never reads the block number", async () => {
    mockEthersState.impl = async () => {
      throw new Error("rpc down");
    };
    const { client, provider } = makeClient();

    await expect(client.call(args())).rejects.toThrow("rpc down");
    expect(provider.getBlockNumber).not.toHaveBeenCalled();
  });

  it("propagates a provider failure while reading the block number", async () => {
    const { client, provider } = makeClient();
    (provider.getBlockNumber as jest.Mock<any>).mockRejectedValueOnce(new Error("provider offline"));

    await expect(client.call(args())).rejects.toThrow("provider offline");
    expect(mockEthersState.calls).toHaveLength(1);
  });
});

/* ─── sendTransaction() ─────────────────────────────────────────────────── */

describe("EthersContractClient.sendTransaction()", () => {
  it("rejects with a typed error when no signer is configured and builds no contract", async () => {
    const { client } = makeClient();

    await expect(client.sendTransaction(args())).rejects.toBeInstanceOf(
      ContractInvalidRequestError,
    );
    await expect(client.sendTransaction(args())).rejects.toThrow(
      "Signer is required for sending transactions",
    );
    expect(mockEthersState.contracts).toHaveLength(0);
  });

  it("builds the write contract against the signer, not the provider", async () => {
    const signer = { address: "0xsigner" };
    mockEthersState.impl = async () => ({ hash: "0xhash" });
    const { client, provider } = makeClient({ signer });

    await client.sendTransaction(args());

    expect(mockEthersState.contracts[0].runner).toBe(signer);
    expect(mockEthersState.contracts[0].runner).not.toBe(provider);
  });

  it("returns the transaction hash from the signer response", async () => {
    mockEthersState.impl = async () => ({ hash: "0xdeadbeef", wait: async () => ({}) });
    const { client } = makeClient({ signer: {} });

    await expect(client.sendTransaction(args())).resolves.toMatchObject({ hash: "0xdeadbeef" });
  });

  it("appends an empty options object when none are supplied", async () => {
    mockEthersState.impl = async () => ({ hash: "0x1", wait: async () => ({}) });
    const { client } = makeClient({ signer: {} });

    await client.sendTransaction(args({ method: "mint", args: ["0x1"] }));

    expect(mockEthersState.calls[0]).toEqual({ method: "mint", args: ["0x1", {}] });
  });

  it("forwards supplied options as the trailing argument", async () => {
    mockEthersState.impl = async () => ({ hash: "0x1", wait: async () => ({}) });
    const { client } = makeClient({ signer: {} });
    const options = { value: 10n, gasLimit: 21_000n };

    await client.sendTransaction(args({ method: "pay", args: ["0x2", 5n], options }));

    expect(mockEthersState.calls[0]).toEqual({ method: "pay", args: ["0x2", 5n, options] });
  });

  it("propagates a write failure", async () => {
    mockEthersState.impl = async () => {
      throw new Error("nonce too low");
    };
    const { client } = makeClient({ signer: {} });

    await expect(client.sendTransaction(args())).rejects.toThrow("nonce too low");
  });
});

describe("EthersContractClient.sendTransaction().wait()", () => {
  it("forwards the confirmation count to the underlying wait", async () => {
    const underlyingWait = jest.fn(async (confirmations?: number) => ({ confirmations }));
    mockEthersState.impl = async () => ({ hash: "0x1", wait: underlyingWait });
    const { client } = makeClient({ signer: {} });

    const result = await client.sendTransaction(args());
    await expect(result.wait(5)).resolves.toEqual({ confirmations: 5 });
    expect(underlyingWait).toHaveBeenCalledWith(5);
  });

  it("passes undefined when no confirmation count is supplied", async () => {
    const underlyingWait = jest.fn(async (_confirmations?: number) => ({ mined: true }));
    mockEthersState.impl = async () => ({ hash: "0x1", wait: underlyingWait });
    const { client } = makeClient({ signer: {} });

    const result = await client.sendTransaction(args());
    await expect(result.wait()).resolves.toEqual({ mined: true });
    expect(underlyingWait).toHaveBeenCalledWith(undefined);
  });

  it("propagates a wait failure", async () => {
    mockEthersState.impl = async () => ({
      hash: "0x1",
      wait: async () => {
        throw new Error("tx reverted");
      },
    });
    const { client } = makeClient({ signer: {} });

    const result = await client.sendTransaction(args());
    await expect(result.wait()).rejects.toThrow("tx reverted");
  });
});

/* ─── protected factory ─────────────────────────────────────────────────── */

describe("EthersContractClient.createContract()", () => {
  it("returns an ethers.Contract built from the supplied runner", () => {
    class Exposed extends EthersContractClient {
      build(address: string, abi: unknown, runner: unknown) {
        return this.createContract(address, abi, runner as never);
      }
    }

    const client = new Exposed({} as never, {} as unknown as ContractService);
    const runner = { kind: "runner" };
    const contract = client.build("0xfeed", [{ name: "x" }], runner);

    expect(contract).toBeDefined();
    expect(mockEthersState.contracts).toHaveLength(1);
    expect(mockEthersState.contracts[0]).toMatchObject({ address: "0xfeed", runner });
  });
});
