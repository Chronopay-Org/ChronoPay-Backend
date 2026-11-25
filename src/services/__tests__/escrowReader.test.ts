import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HorizonEscrowReader } from "../escrowReader.js";
import { escrowReaderMalformedEventsTotal } from "../../metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, "../../../tests/fixtures/soroban-rpc");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const SLOT_1 = "slot-11111111-1111-4111-8111-111111111111";
const SLOT_2 = "slot-22222222-2222-4222-8222-222222222222";
const SLOT_3 = "slot-33333333-3333-4333-8333-333333333333";

function makeLedgerResponse() {
  return {
    _embedded: {
      records: [
        {
          sequence: 12405,
          closed_at: "2026-01-15T10:05:00Z",
          protocol_version: 21,
        },
      ],
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("HorizonEscrowReader.fetchEvents", () => {
  beforeEach(() => {
    escrowReaderMalformedEventsTotal.reset();
  });

  it("paginates through Soroban RPC getEvents fixtures, skips malformed events, and builds snapshot", async () => {
    const page1 = loadFixture("get-events-page-1.json");
    const page2 = loadFixture("get-events-page-2.json");
    const emptyPage = loadFixture("get-events-empty.json");

    const rpcCalls: Array<Record<string, unknown>> = [];
    let rpcPageIndex = 0;
    const rpcResponses = [page1, page2, emptyPage];

    const fetchMock = jest.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/ledgers")) {
        return jsonResponse(makeLedgerResponse());
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method: string;
        params: Record<string, unknown>;
      };
      rpcCalls.push(body.params);
      const next = rpcResponses[rpcPageIndex++] ?? emptyPage;
      return jsonResponse(next);
    });

    const reader = new HorizonEscrowReader({
      id: "reader-1",
      horizonUrl: "https://horizon.example.com",
      sorobanRpcUrl: "https://soroban.example.com",
      contractId: CONTRACT_ID,
      maxPages: 10,
      pageLimit: 50,
      fetchFn: fetchMock,
    });

    const snapshot = await reader.snapshot([SLOT_1, SLOT_2, SLOT_3], 12300);

    // 3 RPC calls: page 1 (startLedger), page 2 (cursor), page 3 (empty -> stop)
    expect(rpcCalls).toHaveLength(3);
    expect(rpcCalls[0]).toEqual({
      startLedger: 12300,
      filters: [{ type: "contract", contractIds: [CONTRACT_ID] }],
      pagination: { limit: 50 },
    });
    expect(rpcCalls[1]).toEqual({
      filters: [{ type: "contract", contractIds: [CONTRACT_ID] }],
      pagination: { cursor: "0000053025792004096-0000000001", limit: 50 },
    });
    expect(rpcCalls[2]).toEqual({
      filters: [{ type: "contract", contractIds: [CONTRACT_ID] }],
      pagination: { cursor: "0000053030086971392-0000000000", limit: 50 },
    });

    expect(snapshot.readerId).toBe("reader-1");
    expect(snapshot.ledgerInfo.latestLedgerSeq).toBe(12405);
    expect(snapshot.slots).toEqual([
      {
        slotId: SLOT_1,
        latestEventKind: "Released",
        latestTxHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        latestLedgerSeq: 12355,
        bookingIntentId: "intent-001",
        eventCount: 2,
      },
      {
        slotId: SLOT_2,
        latestEventKind: "Refunded",
        latestTxHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        latestLedgerSeq: 12360,
        bookingIntentId: "intent-002",
        eventCount: 1,
      },
      {
        slotId: SLOT_3,
        latestEventKind: null,
        latestTxHash: null,
        latestLedgerSeq: -1,
        bookingIntentId: null,
        eventCount: 0,
      },
    ]);

    // 1 malformed event on page 2 was counted and dropped
    const metric = await escrowReaderMalformedEventsTotal.get();
    const readerSample = metric.values.find((v) => v.labels.reader_id === "reader-1");
    expect(readerSample?.value).toBe(1);
  });

  it("filters events by slotId in getSlotEvents", async () => {
    const page1 = loadFixture("get-events-page-1.json");
    const emptyPage = loadFixture("get-events-empty.json");
    let rpcPage = 0;

    const fetchMock = jest.fn<typeof fetch>(async () =>
      jsonResponse(rpcPage++ === 0 ? page1 : emptyPage),
    );

    const reader = new HorizonEscrowReader({
      id: "reader-slot",
      horizonUrl: "https://horizon.example.com",
      sorobanRpcUrl: "https://soroban.example.com",
      contractId: CONTRACT_ID,
      fetchFn: fetchMock,
    });

    const events = await reader.getSlotEvents(SLOT_1, 12300);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.kind)).toEqual(["Held", "Released"]);
  });

  it("stops pagination at configured maxPages even if RPC keeps returning a cursor", async () => {
    const page1 = loadFixture("get-events-page-1.json");

    const fetchMock = jest.fn<typeof fetch>(async (input) => {
      if (String(input).includes("/ledgers")) {
        return jsonResponse(makeLedgerResponse());
      }
      return jsonResponse(page1);
    });

    const reader = new HorizonEscrowReader({
      id: "reader-bounded",
      horizonUrl: "https://horizon.example.com",
      sorobanRpcUrl: "https://soroban.example.com",
      contractId: CONTRACT_ID,
      maxPages: 2,
      fetchFn: fetchMock,
    });

    const events = await reader.getSlotEvents(SLOT_1, 12300);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 2 events per page * 2 pages = 4 events
    expect(events).toHaveLength(4);
  });

  it("throws when Soroban RPC returns a JSON-RPC error", async () => {
    const fetchMock = jest.fn<typeof fetch>(async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "startLedger out of range" },
      }),
    );

    const reader = new HorizonEscrowReader({
      id: "reader-err",
      horizonUrl: "https://horizon.example.com",
      sorobanRpcUrl: "https://soroban.example.com",
      contractId: CONTRACT_ID,
      fetchFn: fetchMock,
    });

    await expect(reader.getSlotEvents(SLOT_1, 1)).rejects.toThrow(
      /Soroban RPC getEvents error \(-32602\): startLedger out of range/,
    );
  });

  it("returns empty events when sorobanRpcUrl is not configured", async () => {
    const fetchMock = jest.fn<typeof fetch>(async () => jsonResponse(makeLedgerResponse()));

    const reader = new HorizonEscrowReader({
      id: "reader-legacy",
      horizonUrl: "https://horizon.example.com",
      fetchFn: fetchMock,
    });

    const events = await reader.getSlotEvents(SLOT_1, 0);
    expect(events).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
