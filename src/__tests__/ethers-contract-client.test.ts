import { jest } from "@jest/globals";
import { ethers } from "ethers";
import { EthersContractClient } from "../clients/ethers-contract-client.js";

describe("EthersContractClient", () => {
  let mockProvider: any;
  let mockSigner: any;
  let mockContractService: any;
  let client: EthersContractClient;

  const mockAbi = [
    {
      name: "balanceOf",
      type: "function",
      inputs: [{ name: "account", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
      stateMutability: "view",
    },
  ];

  beforeEach(() => {
    mockProvider = {
      getBlockNumber: jest.fn<() => Promise<number>>().mockResolvedValue(123456),
    };

    mockSigner = {
      getAddress: jest.fn<() => Promise<string>>().mockResolvedValue("0xSignerAddress"),
    };

    mockContractService = {
      call: jest.fn(async <T>(_desc: string, action: () => Promise<T>): Promise<T> => await action()),
      sendTransaction: jest.fn(async <T>(_desc: string, action: () => Promise<T>): Promise<T> => await action()),
    };

    client = new EthersContractClient(mockProvider as any, mockContractService as any, mockSigner as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should successfully call a read-only contract method", async () => {
    const mockBalance = 1000n;
    const mockMethod = jest.fn<(...args: any[]) => Promise<bigint>>().mockResolvedValue(mockBalance);

    // Mock createContract
    const contractSpy = jest.spyOn(client as any, "createContract").mockImplementation(() => ({
      getFunction: jest.fn().mockReturnValue(mockMethod),
    } as any));

    const result = await client.call({
      address: "0xContractAddress",
      abi: mockAbi,
      method: "balanceOf",
      args: ["0xAccountAddress"],
    });

    expect(result.data).toBe(mockBalance);
    expect(result.blockNumber).toBe(123456);
    expect(mockContractService.call).toHaveBeenCalled();
    expect(mockMethod).toHaveBeenCalledWith("0xAccountAddress");
    
    contractSpy.mockRestore();
  });

  it("should successfully send a transaction", async () => {
    const mockTxHash = "0xTxHash";
    const mockWait = jest.fn<() => Promise<any>>().mockResolvedValue({ status: 1 });
    const mockTxResponse = {
      hash: mockTxHash,
      wait: mockWait,
    };
    const mockMethod = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(mockTxResponse);

    // Mock createContract
    const contractSpy = jest.spyOn(client as any, "createContract").mockImplementation(() => ({
      getFunction: jest.fn().mockReturnValue(mockMethod),
    } as any));

    const result = await client.sendTransaction({
      address: "0xContractAddress",
      abi: [],
      method: "transfer",
      args: ["0xRecipient", 500n],
    });

    expect(result.hash).toBe(mockTxHash);
    const waitResult = await result.wait(1);
    expect(waitResult.status).toBe(1);
    expect(mockWait).toHaveBeenCalledWith(1);
    expect(mockContractService.sendTransaction).toHaveBeenCalled();
    expect(mockMethod).toHaveBeenCalledWith("0xRecipient", 500n, {});

    contractSpy.mockRestore();
  });

  it("should throw error if sending transaction without signer", async () => {
    const clientNoSigner = new EthersContractClient(mockProvider as any, mockContractService as any);

    await expect(clientNoSigner.sendTransaction({
      address: "0xContractAddress",
      abi: [],
      method: "transfer",
      args: ["0xRecipient", 500n],
    })).rejects.toThrow("Signer is required for sending transactions");
  });
});
