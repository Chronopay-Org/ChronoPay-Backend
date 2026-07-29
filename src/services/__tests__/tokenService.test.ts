import { jest } from "@jest/globals";
import { TokenService } from "../tokenService.js";
import { ContractService } from "../contract.service.js";
import { BookingIntentRepository } from "../../modules/booking-intents/booking-intent-repository.js";
import { AppError } from "../../errors/AppError.js";

describe("TokenService - Trustline & Asset Issuance (Issue #437)", () => {
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

  const intentId = "intent-123456";
  const intent = {
    id: intentId,
    slotId: "slot-1",
    professional: "G_ISSUER_123",
    customerId: "G_BUYER_456",
    startTime: 1000,
    endTime: 2000,
    status: "pending" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("mints a new token with operation ordering: changeTrust then payment", async () => {
    // @ts-expect-error - Auto-fixed by script
    mockRepo.findById.mockResolvedValue(intent);
    mockContractService.sendTransaction.mockImplementation(async (desc, action) => {
      return await action();
    });
    // @ts-expect-error - Auto-fixed by script
    mockRepo.updateTokenInfo.mockResolvedValue(undefined);

    const result = await service.mintTimeToken(intentId, {
      buyerPublicKey: "G_BUYER_456",
      issuerPublicKey: "G_ISSUER_123",
      amount: "10",
    });

    expect(result.asset).toBe("CHRONO:INTENT");
    expect(result.trustlineCreated).toBe(true);
    expect(result.operations).toHaveLength(2);
    expect(result.operations![0]).toEqual({
      type: "changeTrust",
      sourceAccount: "G_BUYER_456",
      assetCode: "CHRONO:INTENT",
      assetIssuer: "G_ISSUER_123",
      amountOrLimit: "922337203685.4775807",
    });
    expect(result.operations![1]).toEqual({
      type: "payment",
      sourceAccount: "G_ISSUER_123",
      destinationAccount: "G_BUYER_456",
      assetCode: "CHRONO:INTENT",
      assetIssuer: "G_ISSUER_123",
      amountOrLimit: "10",
    });
    // @ts-expect-error - Auto-fixed by script
    expect(mockRepo.updateTokenInfo).toHaveBeenCalledWith(
      intentId,
      result.asset,
      result.txHash,
    );
  });

  it("skips changeTrust operation when trustline already exists with sufficient limit (no-op path)", async () => {
    // @ts-expect-error - Auto-fixed by script
    mockRepo.findById.mockResolvedValue(intent);
    mockContractService.sendTransaction.mockImplementation(async (desc, action) => {
      return await action();
    });
    // @ts-expect-error - Auto-fixed by script
    mockRepo.updateTokenInfo.mockResolvedValue(undefined);

    const result = await service.mintTimeToken(intentId, {
      buyerPublicKey: "G_BUYER_456",
      issuerPublicKey: "G_ISSUER_123",
      amount: "10",
      existingTrustlines: [
        {
          assetCode: "CHRONO:INTENT",
          assetIssuer: "G_ISSUER_123",
          limit: "100",
        },
      ],
    });

    expect(result.trustlineCreated).toBe(false);
    expect(result.operations).toHaveLength(1);
    expect(result.operations![0].type).toBe("payment");
  });

  it("adds changeTrust when existing trustline has lower limit than required amount", async () => {
    // @ts-expect-error - Auto-fixed by script
    mockRepo.findById.mockResolvedValue(intent);
    mockContractService.sendTransaction.mockImplementation(async (desc, action) => {
      return await action();
    });
    // @ts-expect-error - Auto-fixed by script
    mockRepo.updateTokenInfo.mockResolvedValue(undefined);

    const result = await service.mintTimeToken(intentId, {
      buyerPublicKey: "G_BUYER_456",
      issuerPublicKey: "G_ISSUER_123",
      amount: "50",
      existingTrustlines: [
        {
          assetCode: "CHRONO:INTENT",
          assetIssuer: "G_ISSUER_123",
          limit: "10", // Lower limit!
        },
      ],
    });

    expect(result.trustlineCreated).toBe(true);
    expect(result.operations).toHaveLength(2);
    expect(result.operations![0].type).toBe("changeTrust");
  });

  it("throws ISSUER_REVOKED if issuer flag is revoked", async () => {
    // @ts-expect-error - Auto-fixed by script
    mockRepo.findById.mockResolvedValue(intent);

    await expect(
      service.mintTimeToken(intentId, {
        issuerRevoked: true,
      }),
    ).rejects.toThrow(
      new AppError("Issuer authorization revoked", 400, "ISSUER_REVOKED"),
    );
  });

  it("asserts failure of payment rolls back and does not persist token info", async () => {
    // @ts-expect-error - Auto-fixed by script
    mockRepo.findById.mockResolvedValue(intent);
    mockContractService.sendTransaction.mockImplementation(async (desc, action) => {
      return await action();
    });

    await expect(
      service.mintTimeToken(intentId, {
        simulateFailureStep: "payment",
      }),
    ).rejects.toThrow(
      new AppError(
        "Token minting transaction failed: payment operation failed",
        500,
        "MINT_TRANSACTION_FAILED",
      ),
    );

    // Rollback assertion: token info was NOT updated
    // @ts-expect-error - Auto-fixed by script
    expect(mockRepo.updateTokenInfo).not.toHaveBeenCalled();
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
      trustlineCreated: false,
    });
    expect(mockContractService.sendTransaction).not.toHaveBeenCalled();
    // @ts-expect-error - Auto-fixed by script
    expect(mockRepo.updateTokenInfo).not.toHaveBeenCalled();
  });

  it("throws error if booking intent is not found", async () => {
    // @ts-expect-error - Auto-fixed by script
    mockRepo.findById.mockResolvedValue(undefined);

    await expect(service.mintTimeToken("unknown")).rejects.toThrow(
      new AppError("Booking intent not found", 404, "INTENT_NOT_FOUND"),
    );
  });
});
