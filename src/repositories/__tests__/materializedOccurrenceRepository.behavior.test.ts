import { jest, describe, it, expect, beforeEach } from "@jest/globals";

// ── Mock setup (must happen before the module under test is imported) ─────────

const mockPoolQuery = jest.fn() as jest.Mock<any>;
const mockClientQuery = jest.fn() as jest.Mock<any>;
const mockRelease = jest.fn() as jest.Mock<any>;
const mockConnect = jest.fn() as jest.Mock<any>;

jest.unstable_mockModule("../../db/pool.js", () => ({
  query: mockPoolQuery,
  default: { connect: mockConnect, query: mockPoolQuery },
}));

const { PgMaterializedOccurrenceRepository } =
  await import("../materializedOccurrenceRepository.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

const SERIES_ID = "series-uuid-behavior-1";
const BASE_TIME = new Date("2026-03-01T00:00:00Z").getTime();
const HOUR = 3_600_000;

function fakeClient() {
  return { query: mockClientQuery, release: mockRelease };
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "occ-b-1",
    series_id: SERIES_ID,
    series_version: 2,
    occurrence_date: new Date(BASE_TIME + HOUR),
    materialized_at: new Date(BASE_TIME),
    created_at: new Date(BASE_TIME),
    ...overrides,
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("PgMaterializedOccurrenceRepository – bulkUpsert behavior", () => {
  let repo: InstanceType<typeof PgMaterializedOccurrenceRepository>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(fakeClient());
    repo = new PgMaterializedOccurrenceRepository();
  });

  // ── transaction lifecycle ───────────────────────────────────────────────────

  it("acquires a client from the pool for every call", async () => {
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await repo.bulkUpsert({ seriesId: SERIES_ID, seriesVersion: 1, occurrenceDates: [], materializedAt: BASE_TIME });

    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("releases the client after a successful upsert", async () => {
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await repo.bulkUpsert({ seriesId: SERIES_ID, seriesVersion: 1, occurrenceDates: [], materializedAt: BASE_TIME });

    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("releases the client even when the INSERT throws", async () => {
    // BEGIN  → ok, DELETE → ok, INSERT → fails
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // DELETE
      .mockRejectedValueOnce(new Error("insert failure")); // INSERT

    await expect(
      repo.bulkUpsert({
        seriesId: SERIES_ID,
        seriesVersion: 1,
        occurrenceDates: [BASE_TIME + HOUR],
        materializedAt: BASE_TIME,
      }),
    ).rejects.toThrow("insert failure");

    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("opens a transaction with BEGIN before any writes", async () => {
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await repo.bulkUpsert({ seriesId: SERIES_ID, seriesVersion: 1, occurrenceDates: [], materializedAt: BASE_TIME });

    const firstCall = mockClientQuery.mock.calls[0][0] as string;
    expect(firstCall.trim().toUpperCase()).toBe("BEGIN");
  });

  it("commits the transaction on success", async () => {
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await repo.bulkUpsert({ seriesId: SERIES_ID, seriesVersion: 1, occurrenceDates: [], materializedAt: BASE_TIME });

    const calls = mockClientQuery.mock.calls.map((c) => (c[0] as string).trim().toUpperCase());
    expect(calls).toContain("COMMIT");
  });

  it("rolls back the transaction when the INSERT throws", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // DELETE
      .mockRejectedValueOnce(new Error("db error"));   // INSERT

    await expect(
      repo.bulkUpsert({
        seriesId: SERIES_ID,
        seriesVersion: 1,
        occurrenceDates: [BASE_TIME + HOUR],
        materializedAt: BASE_TIME,
      }),
    ).rejects.toThrow("db error");

    const calls = mockClientQuery.mock.calls.map((c) => (c[0] as string).trim().toUpperCase());
    expect(calls).toContain("ROLLBACK");
  });

  it("re-throws the original error even when ROLLBACK itself fails", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })          // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })          // DELETE
      .mockRejectedValueOnce(new Error("original error"))        // INSERT
      .mockRejectedValueOnce(new Error("rollback also failed")); // ROLLBACK

    await expect(
      repo.bulkUpsert({
        seriesId: SERIES_ID,
        seriesVersion: 1,
        occurrenceDates: [BASE_TIME + HOUR],
        materializedAt: BASE_TIME,
      }),
    ).rejects.toThrow("original error");
  });

  // ── empty occurrenceDates ───────────────────────────────────────────────────

  it("returns an empty array and commits when occurrenceDates is empty", async () => {
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await repo.bulkUpsert({
      seriesId: SERIES_ID,
      seriesVersion: 2,
      occurrenceDates: [],
      materializedAt: BASE_TIME,
    });

    expect(result).toEqual([]);
    const calls = mockClientQuery.mock.calls.map((c) => (c[0] as string).trim().toUpperCase());
    expect(calls).toContain("COMMIT");
    // No INSERT should have been attempted
    expect(calls.some((c) => c.startsWith("INSERT"))).toBe(false);
  });

  it("still deletes existing rows for the series when occurrenceDates is empty", async () => {
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await repo.bulkUpsert({ seriesId: SERIES_ID, seriesVersion: 2, occurrenceDates: [], materializedAt: BASE_TIME });

    const deleteCalls = mockClientQuery.mock.calls.filter((c) =>
      (c[0] as string).toUpperCase().includes("DELETE"),
    );
    expect(deleteCalls.length).toBeGreaterThan(0);
    expect(deleteCalls[0][1]).toContain(SERIES_ID);
  });

  // ── INSERT correctness ──────────────────────────────────────────────────────

  it("inserts exactly one row per occurrence date", async () => {
    const dates = [BASE_TIME + HOUR, BASE_TIME + 2 * HOUR, BASE_TIME + 3 * HOUR];
    const rows = dates.map((d, i) => makeRow({ id: `occ-b-${i + 1}`, occurrence_date: new Date(d) }));

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 3 })   // DELETE
      .mockResolvedValueOnce({ rows, rowCount: 3 })       // INSERT … RETURNING
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });  // COMMIT

    const result = await repo.bulkUpsert({
      seriesId: SERIES_ID,
      seriesVersion: 2,
      occurrenceDates: dates,
      materializedAt: BASE_TIME,
    });

    // All three occurrences must be returned
    expect(result).toHaveLength(3);

    // The INSERT statement must contain placeholders for 3 × 4 parameters
    const insertCall = mockClientQuery.mock.calls.find((c) =>
      (c[0] as string).toUpperCase().trim().startsWith("INSERT"),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toHaveLength(3 * 4); // 3 rows × 4 columns
  });

  it("passes seriesId, seriesVersion, occurrence date, and materializedAt as parameters", async () => {
    const occDate = BASE_TIME + HOUR;
    const row = makeRow({ occurrence_date: new Date(occDate) });

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // DELETE
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 }) // INSERT
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    await repo.bulkUpsert({
      seriesId: SERIES_ID,
      seriesVersion: 2,
      occurrenceDates: [occDate],
      materializedAt: BASE_TIME,
    });

    const insertCall = mockClientQuery.mock.calls.find((c) =>
      (c[0] as string).toUpperCase().trim().startsWith("INSERT"),
    );
    const params = insertCall![1] as unknown[];
    expect(params[0]).toBe(SERIES_ID);
    expect(params[1]).toBe(2);
    expect(params[2]).toEqual(new Date(occDate));
    expect(params[3]).toEqual(new Date(BASE_TIME));
  });

  it("uses the series_id from the DELETE to target only the right series", async () => {
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await repo.bulkUpsert({ seriesId: SERIES_ID, seriesVersion: 1, occurrenceDates: [], materializedAt: BASE_TIME });

    const deleteCall = mockClientQuery.mock.calls.find((c) =>
      (c[0] as string).toUpperCase().includes("DELETE"),
    );
    expect(deleteCall![1]).toContain(SERIES_ID);
  });

  // ── row mapping ─────────────────────────────────────────────────────────────

  it("maps DB rows to MaterializedOccurrence domain objects", async () => {
    const occDate = BASE_TIME + HOUR;
    const row = makeRow({ id: "occ-mapped", occurrence_date: new Date(occDate) });

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const [occ] = await repo.bulkUpsert({
      seriesId: SERIES_ID,
      seriesVersion: 2,
      occurrenceDates: [occDate],
      materializedAt: BASE_TIME,
    });

    expect(occ).toEqual({
      id: "occ-mapped",
      seriesId: SERIES_ID,
      seriesVersion: 2,
      occurrenceDate: occDate,
      materializedAt: BASE_TIME,
      createdAt: BASE_TIME,
    });
  });

  it("coerces series_version to a number (guards against pg returning strings)", async () => {
    const occDate = BASE_TIME + HOUR;
    // pg can return numeric columns as strings in some driver versions
    const row = makeRow({ series_version: "7", occurrence_date: new Date(occDate) });

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const [occ] = await repo.bulkUpsert({
      seriesId: SERIES_ID,
      seriesVersion: 7,
      occurrenceDates: [occDate],
      materializedAt: BASE_TIME,
    });

    expect(typeof occ.seriesVersion).toBe("number");
    expect(occ.seriesVersion).toBe(7);
  });

  // ── pool acquisition failure ────────────────────────────────────────────────

  it("propagates errors when pool.connect() rejects", async () => {
    mockConnect.mockRejectedValueOnce(new Error("pool exhausted"));

    await expect(
      repo.bulkUpsert({ seriesId: SERIES_ID, seriesVersion: 1, occurrenceDates: [], materializedAt: BASE_TIME }),
    ).rejects.toThrow("pool exhausted");
  });

  it("does not attempt to release the client when pool.connect() rejects", async () => {
    mockConnect.mockRejectedValueOnce(new Error("pool exhausted"));

    await expect(
      repo.bulkUpsert({ seriesId: SERIES_ID, seriesVersion: 1, occurrenceDates: [], materializedAt: BASE_TIME }),
    ).rejects.toThrow();

    expect(mockRelease).not.toHaveBeenCalled();
  });

  // ── BEGIN failure ───────────────────────────────────────────────────────────

  it("propagates errors and releases the client when BEGIN fails", async () => {
    mockClientQuery.mockRejectedValueOnce(new Error("BEGIN failed"));

    await expect(
      repo.bulkUpsert({ seriesId: SERIES_ID, seriesVersion: 1, occurrenceDates: [], materializedAt: BASE_TIME }),
    ).rejects.toThrow("BEGIN failed");

    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
