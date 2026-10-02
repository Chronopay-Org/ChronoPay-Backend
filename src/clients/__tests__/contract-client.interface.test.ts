import { jest } from "@jest/globals";
import { ethers } from "ethers";
import { ContractInvalidRequestError } from "../../errors/contractErrors.js";
import { ContractService } from "../../services/contract.service.js";
import { RetryPolicy } from "../../utils/retry-policy.js";
import { EthersContractClient } from "../ethers-contract-client.js";
import type { IContractClient } from "../contract-client.interface.js";
import type { ContractInteractionArgs } from "../types.js";

const ADDRESS = "0x0000000000000000000000000000000000000001";
const ABI = ["function balanceOf(address) view returns (uint256)"];

class TestEthersContractClient extends EthersContractClient {
  constructor(
    provider: ethers.Provider,
    contract: { getFunction: jest.Mock },
    signer?: ethers.Signer,
  ) {
    super(provider, new ContractService(new RetryPolicy({ maxRetries: 0 })), signer);
    this.contract = contract;
  }

  private contract: { getFunction: jest.Mock };

  protected override createContract(): ethers.Contract {
    return this.contract as unknown as ethers.Contract;
  }
}

function makeClient(
  contract: { getFunction: jest.Mock },
  signer?: ethers.Signer,
): IContractClient {
  const provider = {
    getBlockNumber: jest.fn<() => Promise<number>>().mockResolvedValue(123),
  } as unknown as ethers.Provider;
  return new TestEthersContractClient(provider, contract, signer);
}

function interaction(method: string, args: unknown[] = []): ContractInteractionArgs {
  return { address: ADDRESS, abi: ABI, method, args };
}

describe("IContractClient behavior", () => {
  it("returns read data with the observed block number", async () => {
    const read = jest.fn<any>().mockResolvedValue(42n);
    const client = makeClient({ getFunction: jest.fn<any>().mockReturnValue(read) });

    await expect(client.call<bigint>(interaction("balanceOf", [ADDRESS]))).resolves.toEqual({
      data: 42n,
      blockNumber: 123,
    });
    expect(read).toHaveBeenCalledWith(ADDRESS);
  });

  it("rejects an unknown method without changing the read result contract", async () => {
    const contract = {
      getFunction: jest.fn<any>().mockImplementation(() => {
        throw new Error("unknown contract method");
      }),
    };
    const client = makeClient(contract);

    await expect(client.call(interaction("missingMethod"))).rejects.toThrow(
      "unknown contract method",
    );
  });

  it("rejects state changes when no signer is configured", async () => {
    const client = makeClient({ getFunction: jest.fn<any>() });

    await expect(client.sendTransaction(interaction("transfer"))).rejects.toBeInstanceOf(
      ContractInvalidRequestError,
    );
  });

  it("submits a transaction and forwards confirmation depth to wait", async () => {
    const receipt = { status: 1, blockNumber: 456 };
    const wait = jest.fn<any>().mockResolvedValue(receipt);
    const send = jest.fn<any>().mockResolvedValue({ hash: "0xabc", wait });
    const signer = {} as ethers.Signer;
    const client = makeClient(
      { getFunction: jest.fn<any>().mockReturnValue(send) },
      signer,
    );
    const args = {
      ...interaction("transfer", [ADDRESS, 5n]),
      options: { gasLimit: 21_000n },
    };

    const transaction = await client.sendTransaction(args);

    expect(transaction.hash).toBe("0xabc");
    expect(send).toHaveBeenCalledWith(ADDRESS, 5n, args.options);
    await expect(transaction.wait(2)).resolves.toBe(receipt);
    expect(wait).toHaveBeenCalledWith(2);
  });
});