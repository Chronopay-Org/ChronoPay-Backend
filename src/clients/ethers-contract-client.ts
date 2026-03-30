import { ethers } from "ethers";
import { IContractClient } from "./contract-client.interface.js";
import { ContractInteractionArgs, ContractCallResult, TransactionResult } from "./types.js";
import { ContractService } from "../services/contract.service.js";

/**
 * Ethers.js implementation of the IContractClient.
 * 
 * This adapter decouples the application from the underlying blockchain library,
 * providing a consistent interface for contract interactions while integrating
 * with the existing ContractService for retry logic and error handling.
 */
export class EthersContractClient implements IContractClient {
  private provider: ethers.Provider;
  private signer?: ethers.Signer;
  private contractService: ContractService;

  /**
   * Initializes the EthersContractClient.
   * 
   * @param provider An ethers provider instance.
   * @param contractService The ContractService instance for retries.
   * @param signer An optional ethers signer for transactions.
   */
  constructor(
    provider: ethers.Provider,
    contractService: ContractService,
    signer?: ethers.Signer
  ) {
    this.provider = provider;
    this.contractService = contractService;
    this.signer = signer;
  }

  /**
   * Executes a read-only contract call using the retry policy.
   * 
   * @param args Arguments for the contract call (address, abi, method, etc.).
   * @returns The call result with data and block number.
   */
  async call<T>(args: ContractInteractionArgs): Promise<ContractCallResult<T>> {
    const contract = this.createContract(args.address, args.abi, this.provider);
    
    const description = `Contract call: ${args.method} at ${args.address}`;
    
    const data = await this.contractService.call(description, async () => {
      // Accessing the method dynamically; ethers.Contract handles this via Proxy
      const method = contract.getFunction(args.method);
      return await method(...args.args);
    });

    const blockNumber = await this.provider.getBlockNumber();

    return {
      data,
      blockNumber,
    };
  }

  /**
   * Sends a state-changing transaction using the retry policy.
   * 
   * @param args Arguments for the transaction (address, abi, method, etc.).
   * @returns The transaction result with hash and wait function.
   * @throws Error if no signer is provided.
   */
  async sendTransaction(args: ContractInteractionArgs): Promise<TransactionResult> {
    if (!this.signer) {
      throw new Error("Signer is required for sending transactions");
    }

    const contract = this.createContract(args.address, args.abi, this.signer);
    
    const description = `Contract transaction: ${args.method} at ${args.address}`;
    
    const txResponse = await this.contractService.sendTransaction(description, async () => {
      const method = contract.getFunction(args.method);
      return await method(...args.args, args.options || {});
    });

    return {
      hash: txResponse.hash,
      wait: async (confirmations?: number) => await txResponse.wait(confirmations),
    };
  }

  /**
   * Helper method to create an ethers.Contract instance.
   * This is extracted to a method to allow for easier mocking in tests.
   */
  protected createContract(address: string, abi: any, runner: ethers.ContractRunner): ethers.Contract {
    return new ethers.Contract(address, abi, runner);
  }
}
