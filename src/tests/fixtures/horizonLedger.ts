import { randomUUID } from "crypto";
import {
  ContractInteractionArgs,
  ContractCallResult,
  TransactionResult,
} from "../../clients/types.js";
import {
  HorizonTransactionRecord,
  HorizonCollectionResponse,
  HorizonPaginationOptions,
  FetchAllPagesOptions,
  PathPaymentQuoteOptions,
  ExecutedPathPaymentQuote,
  StellarAsset,
} from "../../clients/horizon-contract-client.js";

const FIXTURE_TX_HASH_PREFIX = "fixture-tx-";

function fixtureTxHash(): string {
  return `${FIXTURE_TX_HASH_PREFIX}${randomUUID().slice(0, 8)}`;
}

export class HorizonLedgerFixture {
  private sequenceCounter = 1000;
  private readonly customResponses = new Map<string, unknown>();
  private readonly customSeedCallbacks = new Map<string, (args: any[]) => unknown>();

  public readonly calls: Array<{ method: string; args: unknown[] }> = [];

  reset(): void {
    this.sequenceCounter = 1000;
    this.customResponses.clear();
    this.customSeedCallbacks.clear();
    this.calls.length = 0;
  }

  seed(method: string, response: unknown): void {
    this.customResponses.set(method, response);
  }

  seedCallback(method: string, fn: (args: any[]) => unknown): void {
    this.customSeedCallbacks.set(method, fn);
  }

  currentSequence(): number {
    return this.sequenceCounter;
  }

  private recordCall(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
  }

  private getFixtureResponse<T>(method: string, args: unknown[]): T {
    const cb = this.customSeedCallbacks.get(method);
    if (cb) return cb(args) as T;

    if (this.customResponses.has(method)) {
      return this.customResponses.get(method) as T;
    }
    return this.defaultResponse(method, args) as T;
  }

  private defaultResponse(method: string, args: unknown[]): unknown {
    switch (method) {
      case "getAccount":
        return {
          data: {
            id: args[0] as string,
            sequence: String(this.sequenceCounter++),
            balances: [{ asset_type: "native", balance: "10000000000" }],
            subentry_count: 0,
          },
          blockNumber: 0,
        };

      case "getTransaction":
        return {
          data: {
            id: args[0] as string,
            hash: args[0] as string,
            ledger: 999,
            successful: true,
            memo: "",
            memo_type: "none",
          },
          blockNumber: 0,
        };

      case "getTransactions":
        return {
          data: {
            _embedded: { records: [] },
            _links: {},
          },
          blockNumber: 0,
        };

      case "getLatestLedger":
        return {
          data: {
            _embedded: {
              records: [{ sequence: this.sequenceCounter++ }],
            },
          },
          blockNumber: 0,
        };

      case "submitTransaction":
        return {
          hash: fixtureTxHash(),
          wait: async () => ({
            id: fixtureTxHash(),
            hash: fixtureTxHash(),
            ledger: 999,
            successful: true,
          }),
        };

      case "findPaths":
        return {
          _embedded: {
            records: [
              {
                source_asset_type: "native",
                source_amount: "1.0000000",
                destination_asset_type: "credit_alphanum4",
                destination_asset_code: "USDC",
                destination_asset_issuer: "GBBD47IF6LWKM7LWF3V2YV3N6IY5S7KIXRHHBVL3H7PFT7VLY4QJ7V5",
                destination_amount: "0.9995000",
                path: [],
              },
            ],
          },
        };

      default:
        throw new Error(
          `HorizonLedgerFixture: no default response for method "${method}". Use seed() to provide one.`,
        );
    }
  }

  async call<T>(args: ContractInteractionArgs): Promise<ContractCallResult<T>> {
    this.recordCall(args.method, args.args);
    return this.getFixtureResponse<ContractCallResult<T>>(args.method, args.args);
  }

  async sendTransaction(args: ContractInteractionArgs): Promise<TransactionResult> {
    this.recordCall(args.method, args.args);
    return this.getFixtureResponse<TransactionResult>(args.method, args.args);
  }

  async submitPayout(
    accountId: string,
    _xdr: string,
    _options?: { amount?: string | number; baseReserve?: number; subentries?: number; trustlines?: number; offers?: number },
  ): Promise<TransactionResult> {
    this.recordCall("submitPayout", [accountId]);
    return this.getFixtureResponse<TransactionResult>("submitTransaction", []);
  }

  async submitMemoTransaction(memoHashHex: string): Promise<TransactionResult> {
    this.recordCall("submitMemoTransaction", [memoHashHex]);
    return this.getFixtureResponse<TransactionResult>("submitTransaction", []);
  }

  async getTransactionMemo(txHash: string): Promise<{ hash: string; memo?: string; memo_type?: string }> {
    this.recordCall("getTransactionMemo", [txHash]);
    const res = this.getFixtureResponse<ContractCallResult<{ hash: string; memo?: string; memo_type?: string }>>(
      "getTransaction", [txHash],
    );
    return res.data;
  }

  async getAccountSequence(accountId: string): Promise<string> {
    this.recordCall("getAccountSequence", [accountId]);
    const res = this.getFixtureResponse<ContractCallResult<{ sequence: string }>>("getAccount", [accountId]);
    return res.data.sequence;
  }

  async sendTransactionWithSequenceRecovery(
    initialXdr: string,
    _accountId: string,
    _rebuildXdr: (freshSequence: string) => Promise<string>,
    _options?: { maxRetries?: number; initialDelayMs?: number; useJitter?: boolean; onRetry?: (attempt: number, newSequence: string) => void },
  ): Promise<TransactionResult> {
    this.recordCall("sendTransactionWithSequenceRecovery", [initialXdr]);
    return this.getFixtureResponse<TransactionResult>("submitTransaction", []);
  }

  async getTransactionsPaged<T = HorizonTransactionRecord>(
    accountId: string,
    _options?: HorizonPaginationOptions,
  ): Promise<ContractCallResult<HorizonCollectionResponse<T>>> {
    this.recordCall("getTransactionsPaged", [accountId]);
    return this.getFixtureResponse<ContractCallResult<HorizonCollectionResponse<T>>>("getTransactions", [accountId]);
  }

  async fetchAllTransactionsPaged<T extends { paging_token: string } = HorizonTransactionRecord>(
    accountId: string,
    _options?: FetchAllPagesOptions,
  ): Promise<T[]> {
    this.recordCall("fetchAllTransactionsPaged", [accountId]);
    const res = this.getFixtureResponse<ContractCallResult<HorizonCollectionResponse<T>>>("getTransactions", [accountId]);
    return res.data._embedded.records;
  }

  async findPathPaymentQuote(_options: PathPaymentQuoteOptions): Promise<ExecutedPathPaymentQuote> {
    this.recordCall("findPathPaymentQuote", []);
    const raw = this.getFixtureResponse<{
      _embedded: { records: Array<{ source_amount: string; destination_amount: string; path: StellarAsset[] }> };
    }>("findPaths", []);
    const best = raw._embedded.records[0];
    const tolerance = 0.5;
    const destNum = parseFloat(best.destination_amount);
    const minDest = (Math.floor(destNum * (1 - tolerance / 100) * 1e7) / 1e7).toFixed(7);
    return {
      quoteId: `fixture-quote-${randomUUID().slice(0, 8)}`,
      tenantId: "default",
      sourceAsset: { asset_type: "native" },
      sourceAmount: best.source_amount,
      destinationAsset: { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "GBBD47IF6LWKM7LWF3V2YV3N6IY5S7KIXRHHBVL3H7PFT7VLY4QJ7V5" },
      destinationAmount: best.destination_amount,
      minDestinationAmount: minDest,
      effectiveSlippagePercent: 0,
      maxSlippageTolerancePercent: tolerance,
      path: best.path || [],
      quotedAt: Math.floor(Date.now() / 1000),
    };
  }
}
