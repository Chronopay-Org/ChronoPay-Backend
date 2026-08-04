import { jest } from "@jest/globals";
import { TokenService } from "../tokenService.js";
import { ContractService } from "../contract.service.js";
import {
  BookingIntentRepository,
  InMemoryBookingIntentRepository,
} from "../../modules/booking-intents/booking-intent-repository.js";
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
      listAll: jest.fn().mockReturnValue([]),
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
    (mockRepo.updateTokenInfo as any).mockResolvedValue(undefined);

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
    (mockRepo.updateTokenInfo as any).mockResolvedValue(undefined);

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

describe("TokenService - Cumulative Issuance Overflow Safety & Concurrency", () => {
  it("enforces supplier maximum limit under 10 concurrent issuance requests and returns 409 for rejected ones", async () => {
    const repo = new InMemoryBookingIntentRepository();
    const contractService = {
      sendTransaction: jest.fn(async (desc, action: any) => await action()),
    } as any;

    const supplierId = "G_ISSUER_CONCURRENT";
    const cap = 5;
    const periodStart = new Date("2026-01-01T00:00:00.000Z");
    const periodEnd = new Date("2026-12-31T23:59:59.999Z");

    const service = new TokenService(contractService, repo, {
      getSupplierLimit: (sId) =>
        sId === supplierId ? { maxUnits: cap, periodStart, periodEnd } : null,
    });

    // Create 10 booking intents near cap (1 unit each)
    const intentIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const intent = await repo.create({
        slotId: `slot-${i}`,
        professional: supplierId,
        customerId: `customer-${i}`,
        startTime: 1000 + i * 100,
        endTime: 2000 + i * 100,
        status: "pending",
        createdAt: "2026-06-01T12:00:00.000Z",
      });
      intentIds.push(intent.id);
    }

    // Spin up 10 parallel issuance requests
    const promises = intentIds.map((id) =>
      service.mintTimeToken(id, {
        issuerPublicKey: supplierId,
        amount: "1",
      }),
    );

    const results = await Promise.allSettled(promises);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(5);
    expect(rejected).toHaveLength(5);

    // Each rejected request returns 409 CONFLICT
    for (const rej of rejected) {
      if (rej.status === "rejected") {
        expect(rej.reason).toBeInstanceOf(AppError);
        expect((rej.reason as AppError).statusCode).toBe(409);
        expect((rej.reason as AppError).code).toBe("CONFLICT");
      }
    }

    // Assert final total <= cap
    const allIntents = repo.listAll();
    const mintedIntents = allIntents.filter((i) => i.tokenAsset && i.mintTxHash);
    expect(mintedIntents).toHaveLength(5);
  });

  it("asserts idempotency-key replay doesn't double-count against cumulative limit", async () => {
    const repo = new InMemoryBookingIntentRepository();
    const contractService = {
      sendTransaction: jest.fn(async (desc, action: any) => await action()),
    } as any;

    const supplierId = "G_ISSUER_REPLAY";
    const cap = 2;
    const periodStart = new Date("2026-01-01T00:00:00.000Z");
    const periodEnd = new Date("2026-12-31T23:59:59.999Z");

    const service = new TokenService(contractService, repo);

    const intent1 = await repo.create({
      slotId: "slot-1",
      professional: supplierId,
      customerId: "customer-1",
      startTime: 1000,
      endTime: 2000,
      status: "pending",
      createdAt: "2026-06-01T12:00:00.000Z",
    });

    const intent2 = await repo.create({
      slotId: "slot-2",
      professional: supplierId,
      customerId: "customer-2",
      startTime: 1000,
      endTime: 2000,
      status: "pending",
      createdAt: "2026-06-01T12:00:00.000Z",
    });

    const limitOption = {
      supplierLimit: { maxUnits: cap, periodStart, periodEnd },
      issuerPublicKey: supplierId,
      amount: "1",
    };

    // Mint intent 1 (1 unit, total = 1)
    const res1 = await service.mintTimeToken(intent1.id, limitOption);
    expect(res1.trustlineCreated).toBe(true);

    // Mint intent 2 (1 unit, total = 2 - at cap)
    const res2 = await service.mintTimeToken(intent2.id, limitOption);
    expect(res2.trustlineCreated).toBe(true);

    // Replay intent 1 (already minted): should succeed idempotently and NOT throw 409
    const replayRes1 = await service.mintTimeToken(intent1.id, limitOption);
    expect(replayRes1.txHash).toBe(res1.txHash);
    expect(replayRes1.trustlineCreated).toBe(false);

    // A 3rd distinct intent should be rejected with 409 because cap is 2
    const intent3 = await repo.create({
      slotId: "slot-3",
      professional: supplierId,
      customerId: "customer-3",
      startTime: 1000,
      endTime: 2000,
      status: "pending",
      createdAt: "2026-06-01T12:00:00.000Z",
    });

    await expect(
      service.mintTimeToken(intent3.id, limitOption),
    ).rejects.toThrow(
      new AppError(
        `Supplier ${supplierId} token issuance limit exceeded (3 > 2) for period`,
        409,
        "CONFLICT",
      ),
    );
  });
});

