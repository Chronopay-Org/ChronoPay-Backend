import { ContractService } from "./contract.service.js";
import { BookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import { AppError } from "../errors/AppError.js";

/**
 * Result of a token minting operation.
 */
export interface MintResult {
  asset: string;
  txHash: string;
}

/**
 * Service responsible for minting time-tokens on Stellar representing confirmed slots.
 *
 * This service ensures idempotency by deriving a unique key from the booking intent ID.
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
   * @returns The minted asset identifier and transaction hash.
   * @throws AppError if the intent is not found or minting fails.
   */
  async mintTimeToken(intentId: string): Promise<MintResult> {
    const intent = await this.bookingIntentRepository.findById(intentId);

    if (!intent) {
      throw new AppError("Booking intent not found", 404, "INTENT_NOT_FOUND");
    }

    // Idempotency check: if token is already minted, return existing info.
    if (intent.tokenAsset && intent.mintTxHash) {
      return {
        asset: intent.tokenAsset,
        txHash: intent.mintTxHash,
      };
    }

    // Business logic for minting on Stellar would go here.
    // For now, we use the ContractService to simulate a transaction.
    // In a real implementation, this would call a Stellar Horizon client or a smart contract.
    const result = await this.contractService.sendTransaction(
      `Mint token for intent ${intentId}`,
      async () => {
        // Simulate Stellar asset minting
        // Format: CHRONO:<intent_id_short>
        const assetCode = `CHRONO:${intentId.substring(0, 6).toUpperCase()}`;
        
        // In a real world, this would call Horizon or a Stellar SDK
        // We'll simulate a transaction hash
        const mockTxHash = `st_tx_${Math.random().toString(36).substring(2, 15)}`;
        
        return {
          asset: assetCode,
          txHash: mockTxHash,
        };
      }
    );

    // Persist the resulting token reference
    // @ts-expect-error - Auto-fixed by script
    await this.bookingIntentRepository.updateTokenInfo(
      intentId,
      result.asset,
      result.txHash
    );

    return result;
  }
}
