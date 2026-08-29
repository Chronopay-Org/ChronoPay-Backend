import { jest } from "@jest/globals";
import { TokenService } from "../tokenService.js";
import { ContractService } from "../contract.service.js";
import { BookingIntentRepository } from "../../modules/booking-intents/booking-intent-repository.js";
import { AppError } from "../../errors/AppError.js";
import { Keypair, Networks, Transaction } from "@stellar/stellar-sdk";
import crypto from "crypto";

describe("TokenService", () => {
  let service: TokenService;
  let mockContractService: jest.Mocked<ContractService>;
  let mockRepo: jest.Mocked<BookingIntentRepository>;

  beforeEach(() => {
    mockContractService = {
      sendTransaction: jest.fn(),
    } as any;

    mockRepo = {
      findById: jest.fn(),
      updateTokenInfo: jest.fn(),
    } as any;

    service = new TokenService(mockContractService, mockRepo);
  });

  const intentId = "intent-123";
  const intent = {
    id: intentId,
    slotId: "slot-1",
    professional: "prof-1",
    customerId: "cust-1",
    startTime: 1000,
    endTime: 2000,
    status: "pending" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("mints a new token and persists references", async () => {
    // @ts-expect-error - Auto-fixed by script
    mockRepo.findById.mockResolvedValue(intent);
    mockContractService.sendTransaction.mockImplementation(async (desc, action) => {
      return await action();
    });
    // @ts-expect-error - Auto-fixed by script
    mockRepo.updateTokenInfo.mockResolvedValue(undefined);

    const result = await service.mintTimeToken(intentId);

    expect(result.asset).toMatch(/^CHRONO:[A-Z0-9]{6}$/);
    expect(result.txHash).toMatch(/^st_tx_/);
    // @ts-expect-error - Auto-fixed by script
    expect(mockRepo.updateTokenInfo).toHaveBeenCalledWith(
      intentId,
      result.asset,
      result.txHash
    );
  });

  it("returns existing token info if already minted (idempotency)", async () => {
    const intentWithToken = {
      ...intent,
      tokenAsset: "CHRONO:ABCDEF",
      mintTxHash: "st_tx_123",
    };
    // @ts-expect-error - Auto-fixed by script
    mockRepo.findById.mockResolvedValue(intentWithToken);

    const result = await service.mintTimeToken(intentId);

    expect(result).toEqual({
      asset: "CHRONO:ABCDEF",
      txHash: "st_tx_123",
    });
    expect(mockContractService.sendTransaction).not.toHaveBeenCalled();
    // @ts-expect-error - Auto-fixed by script
    expect(mockRepo.updateTokenInfo).not.toHaveBeenCalled();
  });

  it("throws error if booking intent is not found", async () => {
    // @ts-expect-error - Auto-fixed by script
    mockRepo.findById.mockResolvedValue(undefined);

    await expect(service.mintTimeToken("unknown")).rejects.toThrow(
      new AppError("Booking intent not found", 404, "INTENT_NOT_FOUND")
    );
  });

  describe("buildMintEnvelope", () => {
    it("builds a correct Stellar transaction envelope for minting", () => {
      const signer = Keypair.random();
      const sourceAccount = signer.publicKey();
      
      const envelopeXdr = service.buildMintEnvelope(
        intentId,
        sourceAccount,
        "1000",
        "100",
        signer,
        Networks.TESTNET
      );

      // Decode the envelope
      const tx = new Transaction(envelopeXdr, Networks.TESTNET);
      expect(tx.source).toBe(sourceAccount);
      expect(tx.sequence).toBe("1000");
      expect(tx.fee).toBe("100");
      expect(tx.signatures.length).toBe(1);

      // Memo check (hash uniqueness)
      const expectedHash = crypto.createHash("sha256").update(intentId).digest();
      expect(tx.memo.type).toBe("hash");
      expect(tx.memo.value).toEqual(expectedHash);
    });
  });
});

