import { jest } from "@jest/globals";
import type { QueryResult } from "pg";
import { PgPayoutQuarantineRepository } from "../pgPayoutQuarantineRepository.js";
import type { PayoutQuarantineFailure } from "../payoutQuarantineRepository.js";

function queryResult(
  rows: Record<string, unknown>[],
): QueryResult<Record<string, unknown>> {
  return {
    rows,
    rowCount: rows.length,
    command: "",
    oid: 0,
    fields: [],
  };
}

function quarantineRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    payout_id: "payout-1",
    supplier_id: "supplier-1",
    total_failures: 3,
    threshold: 3,
    status: "quarantined",
    last_error_class: "NETWORK",
    last_error_message: "timeout",
    quarantined_at: new Date("2026-01-02T03:04:05.000Z"),
    released_at: null,
    quarantine_reason: "failure-threshold-reached",
    release_reason: null,
    released_by: null,
    quarantine_event_id: "00000000-0000-4000-8000-000000000001",
    created_at: new Date("2026-01-02T03:00:00.000Z"),
    updated_at: new Date("2026-01-02T03:04:05.000Z"),
    ...overrides,
  };
}

describe("PgPayoutQuarantineRepository", () => {
  let dbQuery: jest.Mock<
    Promise<QueryResult<Record<string, unknown>>>,
    [string, (unknown[] | undefined)?]
  >;
  let repository: PgPayoutQuarantineRepository;

  beforeEach(() => {
    dbQuery = jest.fn();
    repository = new PgPayoutQuarantineRepository(dbQuery);
  });

  it("atomically increments failures and returns the threshold transition", async () => {
    const failure: PayoutQuarantineFailure = {
      payoutId: "payout-1",
      supplierId: "supplier-1",
      threshold: 3,
      errorClass: "NETWORK",
      errorMessage: "timeout",
      operationId: "00000000-0000-4000-8000-000000000001",
    };
    dbQuery.mockResolvedValueOnce(
      queryResult([
        quarantineRow({
          newly_quarantined: true,
        }),
      ]),
    );

    await expect(repository.upsert(failure)).resolves.toEqual({
      entry: expect.objectContaining({
        payoutId: failure.payoutId,
        totalFailures: 3,
        status: "quarantined",
        quarantineReason: "failure-threshold-reached",
      }),
      newlyQuarantined: true,
    });

    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toContain("ON CONFLICT (payout_id) DO UPDATE");
    expect(sql).toContain("existing.total_failures + 1");
    expect(sql).toContain("quarantine_event_id = $6::uuid");
    expect(params).toEqual([
      failure.payoutId,
      failure.supplierId,
      failure.threshold,
      failure.errorClass,
      failure.errorMessage,
      failure.operationId,
    ]);
  });

  it("does not report an alert transition for later failures", async () => {
    dbQuery.mockResolvedValueOnce(
      queryResult([quarantineRow({ newly_quarantined: false })]),
    );

    const result = await repository.upsert({
      payoutId: "payout-1",
      threshold: 3,
      operationId: "00000000-0000-4000-8000-000000000002",
    });

    expect(result.newlyQuarantined).toBe(false);
    expect(result.entry.status).toBe("quarantined");
  });

  it("gets, lists, and releases persisted entries", async () => {
    dbQuery.mockResolvedValueOnce(queryResult([quarantineRow()]));
    await expect(repository.get("payout-1")).resolves.toMatchObject({
      payoutId: "payout-1",
      totalFailures: 3,
      status: "quarantined",
    });

    dbQuery.mockResolvedValueOnce(queryResult([quarantineRow()]));
    await expect(repository.list()).resolves.toHaveLength(1);

    dbQuery.mockResolvedValueOnce(queryResult([{ payout_id: "payout-1" }]));
    await expect(
      repository.release("payout-1", {
        reason: "Reviewed",
        releasedBy: "admin-1",
      }),
    ).resolves.toBe(true);
    expect(dbQuery.mock.calls[2][1]).toEqual([
      "payout-1",
      "Reviewed",
      "admin-1",
    ]);

    dbQuery.mockResolvedValueOnce(queryResult([]));
    await expect(
      repository.release("missing", {}),
    ).resolves.toBe(false);
  });
});
