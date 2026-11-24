import { describe, it, expect } from "@jest/globals";
import { SlotRepositoryTzStore } from "../scheduler/slotRepositoryTzStore.js";
import { scanTzDriftOnce } from "../scheduler/tzDriftMonitor.js";
import { InMemorySlotRepository, type SlotRecord } from "../modules/slots/slot-repository.js";
import { tzDriftSlotsScannedTotal } from "../metrics.js";

function makeRows(count: number): SlotRecord[] {
  // Deliberately inserted in reverse so ordering must come from the adapter.
  return Array.from({ length: count }, (_, i) => ({
    id: `slot-${String(i).padStart(4, "0")}`,
    professional: `pro-${i % 7}`,
    startTime: Date.UTC(2026, 5, 1, 8) + i * 3_600_000,
    endTime: Date.UTC(2026, 5, 1, 9) + i * 3_600_000,
  })).reverse();
}

function collectAll(store: SlotRepositoryTzStore, pageSize: number) {
  const pages: string[][] = [];
  let cursor: string | undefined;
  do {
    const page = store.listPage(cursor, pageSize);
    pages.push(page.slots.map((s) => s.id));
    cursor = page.nextCursor;
  } while (cursor);
  return pages;
}

describe("SlotRepositoryTzStore", () => {
  it("maps slot records to TZSlotRecord", () => {
    const store = new SlotRepositoryTzStore(
      new InMemorySlotRepository([
        { id: 42, professional: "alice", startTime: 1, endTime: 2, createdAt: "2026-01-01T00:00:00Z" },
      ]),
    );
    expect(store.listPage().slots).toEqual([
      { id: "42", professionalId: "alice", startTime: 1, endTime: 2, createdAt: "2026-01-01T00:00:00Z" },
    ]);
  });

  it("pages 250 rows at size 100 without skipping or repeating", () => {
    const store = new SlotRepositoryTzStore(new InMemorySlotRepository(makeRows(250)));
    expect(store.size()).toBe(250);

    const pages = collectAll(store, 100);
    expect(pages.map((p) => p.length)).toEqual([100, 100, 50]);

    const ids = pages.flat();
    expect(new Set(ids).size).toBe(250);
    expect(ids).toEqual([...ids].sort());
    expect(ids[0]).toBe("slot-0000");
    expect(ids[249]).toBe("slot-0249");
  });

  it("stops cleanly when the row count is an exact multiple of the page size", () => {
    const store = new SlotRepositoryTzStore(new InMemorySlotRepository(makeRows(200)));
    const pages = collectAll(store, 100);
    expect(pages.map((p) => p.length)).toEqual([100, 100]);
  });

  it("returns an empty page for an empty repository and for a cursor past the end", () => {
    const empty = new SlotRepositoryTzStore(new InMemorySlotRepository([]));
    expect(empty.listPage()).toEqual({ slots: [], nextCursor: undefined });

    const store = new SlotRepositoryTzStore(new InMemorySlotRepository(makeRows(3)));
    expect(store.listPage("slot-9999")).toEqual({ slots: [], nextCursor: undefined });
  });

  it("feeds scanTzDriftOnce so every real slot is scanned and the gauge moves", async () => {
    const store = new SlotRepositoryTzStore(new InMemorySlotRepository(makeRows(250)));
    const before = (await tzDriftSlotsScannedTotal.get()).values[0]?.value ?? 0;

    const result = scanTzDriftOnce(store, { pageSize: 100 });

    expect(result.slotsScanned).toBe(250);
    const after = (await tzDriftSlotsScannedTotal.get()).values[0]?.value ?? 0;
    expect(after - before).toBe(250);
  });
});
