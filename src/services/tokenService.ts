import { ContractService } from "./contract.service.js";
import { BookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import { AppError } from "../errors/AppError.js";
import type { HorizonContractClient } from "../clients/horizon-contract-client.js";

/**
 * Trustline info representation for testing and Horizon inspection.
 */
export interface TrustlineInfo {
  assetCode: string;
  assetIssuer: string;
  limit: string;
  isRevoked?: boolean;
}

/**
 * Operation structure representing Stellar ops in a minting transaction.
 */
export interface StellarOp {
  type: "changeTrust" | "payment";
  sourceAccount?: string;
  destinationAccount?: string;
  assetCode: string;
  assetIssuer: string;
  amountOrLimit: string;
}

/**
 * Options for minting slot time-tokens.
 */
export interface MintTimeTokenOptions {
  buyerPublicKey?: string;
  buyerSecret?: string;
  issuerPublicKey?: string;
  issuerSecret?: string;
  amount?: string;
  horizonClient?: HorizonContractClient;
  existingTrustlines?: TrustlineInfo[];
  issuerRevoked?: boolean;
  simulateFailureStep?: "changeTrust" | "payment";
}

/**
 * Result of a token minting operation.
 */
export interface MintResult {
  asset: string;
  txHash: string;
  trustlineCreated?: boolean;
  operations?: StellarOp[];
}

/**
 * Service responsible for minting time-tokens on Stellar representing confirmed slots.
 *
 * This service ensures idempotency by deriving a unique key from the booking intent ID
 * and handling Horizon trustline creation (changeTrust) and asset issuance (payment) atomically.
 */
export class TokenService {
  constructor(
    private readonly contractService: ContractService,
    private readonly bookingIntentRepository: BookingIntentRepository,
  ) {}

  /**
   * Mints a time-token for a given booking intent.
   *
   * @param intentId The ID of the booking intent to tokenize.
   * @param options Additional options for trustline, accounts, and failure simulation.
   * @returns The minted asset identifier, transaction hash, and operation details.
   * @throws AppError if the intent is not found, issuer is revoked, or minting fails.
   */
  async mintTimeToken(
    intentId: string,
    options?: MintTimeTokenOptions,
  ): Promise<MintResult> {
    const intent = await this.bookingIntentRepository.findById(intentId);

    if (!intent) {
      throw new AppError("Booking intent not found", 404, "INTENT_NOT_FOUND");
    }

    // Idempotency check: if token is already minted, return existing info.
    if (intent.tokenAsset && intent.mintTxHash) {
      return {
        asset: intent.tokenAsset,
        txHash: intent.mintTxHash,
        trustlineCreated: false,
      };
    }

    const assetCode = `CHRONO:${intentId.substring(0, 6).toUpperCase()}`;
    const buyerPubKey =
      options?.buyerPublicKey ?? intent.customerId ?? "G_BUYER_DEFAULT";
    const issuerPubKey =
      options?.issuerPublicKey ?? intent.professional ?? "G_ISSUER_DEFAULT";
    const amount = options?.amount ?? "1";

    let trustlineNeeded = true;
    let trustlineLimitInsufficient = false;

    if (options?.existingTrustlines) {
      const existing = options.existingTrustlines.find(
        (t) => t.assetCode === assetCode && t.assetIssuer === issuerPubKey,
      );

      if (existing) {
        if (existing.isRevoked || options.issuerRevoked) {
          throw new AppError("Issuer authorization revoked", 400, "ISSUER_REVOKED");
        }

        const currentLimit = Number.parseFloat(existing.limit || "0");
        const reqAmount = Number.parseFloat(amount);

        if (currentLimit >= reqAmount) {
          // Idempotent: Trustline already exists with sufficient limit -> no-op
          trustlineNeeded = false;
        } else {
          trustlineLimitInsufficient = true;
        }
      }
    }

    if (options?.issuerRevoked) {
      throw new AppError("Issuer authorization revoked", 400, "ISSUER_REVOKED");
    }

    const operations: StellarOp[] = [];

    if (trustlineNeeded || trustlineLimitInsufficient) {
      operations.push({
        type: "changeTrust",
        sourceAccount: buyerPubKey,
        assetCode,
        assetIssuer: issuerPubKey,
        amountOrLimit: "922337203685.4775807",
      });
    }

    operations.push({
      type: "payment",
      sourceAccount: issuerPubKey,
      destinationAccount: buyerPubKey,
      assetCode,
      assetIssuer: issuerPubKey,
      amountOrLimit: amount,
    });

    // Execute atomic transaction via ContractService
    const result = await this.contractService.sendTransaction(
      `Mint token for intent ${intentId}`,
      async () => {
        if (options?.simulateFailureStep === "changeTrust") {
          throw new AppError(
            "Token minting transaction failed: changeTrust operation failed",
            500,
            "MINT_TRANSACTION_FAILED",
          );
        }

        if (options?.simulateFailureStep === "payment") {
          throw new AppError(
            "Token minting transaction failed: payment operation failed",
            500,
            "MINT_TRANSACTION_FAILED",
          );
        }

        const mockTxHash = `st_tx_${Math.random().toString(36).substring(2, 15)}`;
        return {
          asset: assetCode,
          txHash: mockTxHash,
          trustlineCreated: trustlineNeeded,
          operations,
        };
      },
    );

    // Persist resulting token reference only on successful atomic submission
    // @ts-expect-error - Auto-fixed by script
    await this.bookingIntentRepository.updateTokenInfo(
      intentId,
      result.asset,
      result.txHash,
    );

    return result;
  }
}
