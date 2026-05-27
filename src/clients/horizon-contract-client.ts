import { IContractClient } from "./contract-client.interface.js";
import { ContractInteractionArgs, ContractCallResult, TransactionResult } from "./types.js";
import { ContractService } from "../services/contract.service.js";
import { ContractInvalidRequestError } from "../errors/contractErrors.js";
import { withTimeout } from "../utils/outbound-helper.js";
import { timeoutConfig } from "../config/timeouts.js";

/**
 * Stellar Horizon HTTP API client implementing IContractClient.
 *
 * Maps Horizon REST endpoints onto the generic contract interface:
 *   - call()            → GET  /accounts/:address  (read-only queries)
 *   - sendTransaction() → POST /transactions        (XDR envelope submission)
 *
 * The `method` field in ContractInteractionArgs selects the Horizon operation:
 *   call:            "getAccount" | "getTransactions" | "getTransaction"
 *   sendTransaction: "submitTransaction"
 *
 * `args[0]` carries the primary resource identifier (account id, tx hash, or XDR).
 */
export class HorizonContractClient implements IContractClient {
  private readonly horizonUrl: string;
  private readonly networkPassphrase: string;
  private readonly contractService: ContractService;

  constructor(horizonUrl: string, networkPassphrase: string, contractService: ContractService) {
    this.horizonUrl = horizonUrl.replace(/\/$/, "");
    this.networkPassphrase = networkPassphrase;
    this.contractService = contractService;
  }

  /**
   * Executes a read-only Horizon query.
   *
   * Supported methods:
   *   - "getAccount"      → GET /accounts/{args[0]}
   *   - "getTransactions" → GET /accounts/{args[0]}/transactions
   *   - "getTransaction"  → GET /transactions/{args[0]}
   */
  async call<T>(args: ContractInteractionArgs): Promise<ContractCallResult<T>> {
    const url = this.buildReadUrl(args.method, args.args);

    const data = await this.contractService.call<T>(
      `horizon:${args.method}`,
      () =>
        withTimeout(
          async (signal) => this.fetchJson<T>(url, { signal }),
          timeoutConfig.http.contractMs,
          "horizon",
        ),
    );

    return { data, blockNumber: 0 };
  }

  /**
   * Submits a signed Stellar transaction XDR envelope to Horizon.
   *
   * args.args[0] must be the base64-encoded XDR transaction envelope.
   */
  async sendTransaction(args: ContractInteractionArgs): Promise<TransactionResult> {
    const xdr = args.args[0] as string;
    const url = `${this.horizonUrl}/transactions`;

    const response = await this.contractService.sendTransaction<{ hash: string }>(
      "horizon:submitTransaction",
      () =>
        withTimeout(
          async (signal) =>
            this.fetchJson<{ hash: string }>(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: `tx=${encodeURIComponent(xdr)}`,
              signal,
            }),
          timeoutConfig.http.contractMs,
          "horizon",
        ),
    );

    return {
      hash: response.hash,
      wait: async () => {
        const txUrl = `${this.horizonUrl}/transactions/${response.hash}`;
        return withTimeout(
          async (signal) => this.fetchJson(txUrl, { signal }),
          timeoutConfig.http.contractMs,
          "horizon",
        );
      },
    };
  }

  private buildReadUrl(method: string, methodArgs: any[]): string {
    const id = methodArgs[0] as string;
    switch (method) {
      case "getAccount":
        return `${this.horizonUrl}/accounts/${encodeURIComponent(id)}`;
      case "getTransactions":
        return `${this.horizonUrl}/accounts/${encodeURIComponent(id)}/transactions`;
      case "getTransaction":
        return `${this.horizonUrl}/transactions/${encodeURIComponent(id)}`;
      default:
        throw new ContractInvalidRequestError(`Unknown Horizon method: ${method}`);
    }
  }

  private async fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      // Network-level error (ECONNRESET, ETIMEDOUT, etc.) — rethrow raw so
      // mapContractError in ContractService can classify it correctly.
      throw err;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new HorizonHttpError(response.status, body);
    }

    try {
      return (await response.json()) as T;
    } catch {
      // "malformed" doesn't match any mapContractError pattern → ContractExecutionError
      throw new Error("Horizon returned malformed JSON response");
    }
  }
}

/**
 * Represents an HTTP error from the Horizon API.
 * The message is crafted to match patterns in mapContractError:
 *   - 5xx → "service unavailable" → ContractProviderUnavailableError
 *   - 429 → "rate limit"          → ContractRateLimitError
 *   - 4xx → "invalid argument"    → ContractInvalidRequestError
 */
export class HorizonHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    body: string,
  ) {
    super(HorizonHttpError.buildMessage(statusCode, body));
    this.name = "HorizonHttpError";
  }

  private static buildMessage(status: number, body: string): string {
    const detail = body.slice(0, 200);
    if (status >= 500) return `service unavailable: Horizon HTTP ${status}: ${detail}`;
    if (status === 429) return `rate limit exceeded: Horizon HTTP ${status}: ${detail}`;
    return `invalid argument: Horizon HTTP ${status}: ${detail}`;
  }
}
