/**
 * Common types for blockchain contract interactions.
 */

export type Address = string;

export interface ContractInteractionArgs {
  address: Address;
  abi: any;
  method: string;
  args: any[];
  options?: {
    value?: bigint;
    gasLimit?: bigint;
  };
}

export interface ContractCallResult<T = any> {
  data: T;
  blockNumber: number;
}

export interface TransactionResult {
  hash: string;
  wait: (confirmations?: number) => Promise<any>;
}
