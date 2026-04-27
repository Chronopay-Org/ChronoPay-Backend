import { ContractInteractionArgs, ContractCallResult, TransactionResult } from "./types.js";

/**
 * Interface definition for a blockchain contract client adapter.
 */
export interface IContractClient {
  /**
   * Performs a read-only call to a contract method.
   */
  call<T>(args: ContractInteractionArgs): Promise<ContractCallResult<T>>;

  /**
   * Sends a state-changing transaction to a contract method.
   */
  sendTransaction(args: ContractInteractionArgs): Promise<TransactionResult>;
}
