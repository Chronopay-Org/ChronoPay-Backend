import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { KycSupplierNotFoundError } from "../kycProvider.js";

const mockQuery = jest.fn() as any;
jest.unstable_mockModule("../../db/pool.js", () => {
  return {
    query: mockQuery,
    default: { query: mockQuery },
  };
});

const { KycService } = await import("../kycService.js");

const SUPPLIER_ID = "550e8400-e29b-41d4-a716-446655440000";

function pendingSupplier(overrides: Record<string, unknown> = {}) {
  return {
    id: SUPPLIER_ID,
    email: "supplier@example.com",
    kyc_status: "pending",
    kyc_ref: null,
    region: null,
    ...overrides,
  };
}

function selectResponse(row: Record<string, unknown> | null) {
  return {
    rowCount: row ? 1 : 0,
    rows: row ? [row] : [],
  };
}

function updateResponse(rowCount: number) {
  return { rowCount, rows: [] };
}

describe("KycService", () => {
  let bootstrap: { grant: jest.Mock; revoke: jest.Mock };

  beforeEach(() => {
    mockQuery.mockReset();
    bootstrap = {
      grant: jest.fn(),
      revoke: jest.fn(),
    };
  });

  function buildService() {
    return new KycService(bootstrap as any);
  }

  it("advances pending -> verified and grants reputation bootstrap once", async () => {
    mockQuery.mockResolvedValueOnce(selectResponse(pendingSupplier()));
    mockQuery.mockResolvedValueOnce(updateResponse(1));

    const service = buildService();
    const ok = await service.processWebhook({
      supplierId: SUPPLIER_ID,
      kycRef: "ref-123",
      status: "verified",
    });

    expect(ok).toBe(true);
    expect(mockQuery.mock.calls[1][1]).toEqual(["verified", "ref-123", SUPPLIER_ID]);
    expect(bootstrap.grant).toHaveBeenCalledTimes(1);
    expect(bootstrap.grant).toHaveBeenCalledWith({
      supplierId: SUPPLIER_ID,
      email: "supplier@example.com",
      kycStatus: "verified",
      kycRef: "ref-123",
      region: null,
    });
    expect(bootstrap.revoke).not.toHaveBeenCalled();
  });

  it("does not re-grant bootstrap on duplicate verified delivery (retry-safe)", async () => {
    mockQuery.mockResolvedValueOnce(
      selectResponse(pendingSupplier({ kyc_status: "verified", kyc_ref: "ref-123" })),
    );
    mockQuery.mockResolvedValueOnce(updateResponse(1));

    const service = buildService();
    const ok = await service.processWebhook({
      supplierId: SUPPLIER_ID,
      kycRef: "ref-123",
      status: "verified",
    });

    expect(ok).toBe(true);
    expect(bootstrap.grant).not.toHaveBeenCalled();
    expect(bootstrap.revoke).not.toHaveBeenCalled();
  });

  it("rolls back verified -> rejected and revokes bootstrap", async () => {
    mockQuery.mockResolvedValueOnce(
      selectResponse(pendingSupplier({ kyc_status: "verified", kyc_ref: "ref-old" })),
    );
    mockQuery.mockResolvedValueOnce(updateResponse(1));

    const service = buildService();
    const ok = await service.processWebhook({
      supplierId: SUPPLIER_ID,
      kycRef: "ref-new",
      status: "rejected",
    });

    expect(ok).toBe(true);
    expect(mockQuery.mock.calls[1][1]).toEqual(["rejected", "ref-new", SUPPLIER_ID]);
    expect(bootstrap.revoke).toHaveBeenCalledWith(SUPPLIER_ID, "KYC_STATUS_REVOKED");
    expect(bootstrap.grant).not.toHaveBeenCalled();
  });

  it("does nothing to bootstrap on non-terminal status changes", async () => {
    mockQuery.mockResolvedValueOnce(selectResponse(pendingSupplier()));
    mockQuery.mockResolvedValueOnce(updateResponse(1));

    const service = buildService();
    const ok = await service.processWebhook({
      supplierId: SUPPLIER_ID,
      kycRef: "ref-123",
      status: "under_review",
    });

    expect(ok).toBe(true);
    expect(bootstrap.grant).not.toHaveBeenCalled();
    expect(bootstrap.revoke).not.toHaveBeenCalled();
  });

  it("throws KycSupplierNotFoundError when the supplier does not exist", async () => {
    mockQuery.mockResolvedValueOnce(selectResponse(null));

    const service = buildService();
    await expect(
      service.processWebhook({
        supplierId: SUPPLIER_ID,
        kycRef: "ref-123",
        status: "verified",
      }),
    ).rejects.toBeInstanceOf(KycSupplierNotFoundError);
    expect(bootstrap.grant).not.toHaveBeenCalled();
  });

  it("returns false when the update matches zero rows (concurrent deletion)", async () => {
    mockQuery.mockResolvedValueOnce(selectResponse(pendingSupplier()));
    mockQuery.mockResolvedValueOnce(updateResponse(0));

    const service = buildService();
    const ok = await service.processWebhook({
      supplierId: SUPPLIER_ID,
      kycRef: "ref-123",
      status: "verified",
    });

    expect(ok).toBe(false);
    expect(bootstrap.grant).not.toHaveBeenCalled();
  });

  it("propagates datastore failures so callers can retry", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection reset"));

    const service = buildService();
    await expect(
      service.processWebhook({
        supplierId: SUPPLIER_ID,
        kycRef: "ref-123",
        status: "verified",
      }),
    ).rejects.toThrow("connection reset");
  });

  it("getSupplierKyc returns null when no row exists", async () => {
    mockQuery.mockResolvedValueOnce(selectResponse(null));

    const service = buildService();
    await expect(service.getSupplierKyc("missing-id")).resolves.toBeNull();
  });

  it("getSupplierKyc returns null when the datastore returns no result", async () => {
    mockQuery.mockResolvedValueOnce(null);

    const service = buildService();
    await expect(service.getSupplierKyc(SUPPLIER_ID)).resolves.toBeNull();
  });

  it("getSupplierKyc treats a null rowCount as no row", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: null, rows: [] });

    const service = buildService();
    await expect(service.getSupplierKyc(SUPPLIER_ID)).resolves.toBeNull();
  });

  it("updateKycStatus returns false when the update returns no result", async () => {
    mockQuery.mockResolvedValueOnce(null);

    const service = buildService();
    const ok = await service.updateKycStatus(SUPPLIER_ID, "verified", "ref-123");

    expect(ok).toBe(false);
  });

  it("getSupplierKyc maps kyc_status and kyc_ref fields", async () => {
    mockQuery.mockResolvedValueOnce(
      selectResponse(pendingSupplier({ kyc_status: "verified", kyc_ref: "ref-xyz", region: "US" })),
    );

    const service = buildService();
    const info = await service.getSupplierKyc(SUPPLIER_ID);

    expect(mockQuery.mock.calls[0][0]).toContain(
      "SELECT id, email, kyc_status, kyc_ref, region FROM users",
    );
    expect(info).toEqual({
      id: SUPPLIER_ID,
      email: "supplier@example.com",
      kycStatus: "verified",
      kycRef: "ref-xyz",
      region: "US",
    });
  });
});
