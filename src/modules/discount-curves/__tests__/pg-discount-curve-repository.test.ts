import { jest } from "@jest/globals";
import type { QueryResult } from "pg";
import { PgDiscountCurveRepository } from "../pg-discount-curve-repository.js";
import type { DiscountCurveRecord } from "../discount-curve-repository.js";

function result(rows: Record<string, unknown>[]): QueryResult<Record<string, unknown>> {
  return {
    rows,
    rowCount: rows.length,
    command: "",
    oid: 0,
    fields: [],
  };
}

const curve: DiscountCurveRecord = {
  id: "curve-1",
  name: "Bundle discount",
  description: "Seasonal pricing",
  supplierId: "supplier-1",
  bundleId: "bundle-1",
  tiers: [{ minQuantity: 5, discountRate: 0.1 }],
  stackability: {
    stackable: true,
    stackableWith: ["curve-2"],
    maxStackCount: 1,
  },
  active: true,
  validFrom: 1_700_000_000_000,
  validUntil: 1_800_000_000_000,
  createdAt: 1_700_000_000_100,
  updatedAt: 1_700_000_000_200,
};

function databaseRow(): Record<string, unknown> {
  return {
    id: curve.id,
    name: curve.name,
    description: curve.description,
    supplier_id: curve.supplierId,
    bundle_id: curve.bundleId,
    tiers: curve.tiers,
    stackability: curve.stackability,
    active: curve.active,
    valid_from: String(curve.validFrom),
    valid_until: String(curve.validUntil),
    created_at: new Date(curve.createdAt),
    updated_at: new Date(curve.updatedAt),
  };
}

describe("PgDiscountCurveRepository", () => {
  let dbQuery: jest.Mock<
    Promise<QueryResult<Record<string, unknown>>>,
    [string, (unknown[] | undefined)?]
  >;
  let repository: PgDiscountCurveRepository;

  beforeEach(() => {
    dbQuery = jest.fn();
    repository = new PgDiscountCurveRepository(dbQuery);
  });

  it("persists JSON fields and maps the returned PostgreSQL row", async () => {
    dbQuery.mockResolvedValueOnce(result([databaseRow()]));

    await expect(repository.create(curve)).resolves.toEqual(curve);
    expect(dbQuery.mock.calls[0][0]).toContain("INSERT INTO discount_curves");
    expect(dbQuery.mock.calls[0][1]).toEqual([
      curve.id,
      curve.name,
      curve.description,
      curve.supplierId,
      curve.bundleId,
      JSON.stringify(curve.tiers),
      JSON.stringify(curve.stackability),
      curve.active,
      curve.validFrom,
      curve.validUntil,
      new Date(curve.createdAt),
      new Date(curve.updatedAt),
    ]);
  });

  it("loads and filters records, including numeric epoch fields", async () => {
    dbQuery.mockResolvedValueOnce(result([databaseRow()]));
    await expect(repository.findById(curve.id)).resolves.toEqual(curve);

    dbQuery.mockResolvedValueOnce(result([databaseRow()]));
    await expect(
      repository.list({
        supplierId: curve.supplierId,
        bundleId: curve.bundleId,
        active: true,
      }),
    ).resolves.toEqual([curve]);
    expect(dbQuery.mock.calls[1][1]).toEqual([
      curve.supplierId,
      curve.bundleId,
      true,
    ]);
  });

  it("updates and deletes records and reports missing rows", async () => {
    const updated = { ...curve, name: "Updated" };
    dbQuery.mockResolvedValueOnce(
      result([{ ...databaseRow(), name: updated.name }]),
    );
    await expect(repository.update(curve.id, updated)).resolves.toMatchObject({
      name: "Updated",
      createdAt: curve.createdAt,
    });

    dbQuery.mockResolvedValueOnce(result([]));
    await expect(repository.update(curve.id, updated)).resolves.toBeUndefined();
    dbQuery.mockResolvedValueOnce(result([]));
    await expect(repository.findById(curve.id)).resolves.toBeUndefined();
    dbQuery.mockResolvedValueOnce(result([{}]));
    await expect(repository.delete(curve.id)).resolves.toBe(true);
    dbQuery.mockResolvedValueOnce(result([]));
    await expect(repository.delete(curve.id)).resolves.toBe(false);
  });

  it("translates PostgreSQL duplicate-key errors", async () => {
    dbQuery.mockRejectedValueOnce({ code: "23505" });
    await expect(repository.create(curve)).rejects.toThrow(
      `Discount curve with ID ${curve.id} already exists`,
    );
  });
});
