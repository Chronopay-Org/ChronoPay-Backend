import { describe, it, expect, beforeEach } from "@jest/globals";
import { HorizonLedgerFixture } from "./horizonLedger.js";
import { HorizonCollectionResponse, HorizonTransactionRecord } from "../../clients/horizon-contract-client.js";

describe("HorizonLedgerFixture", () => {
  let fixture: HorizonLedgerFixture;

  beforeEach(() => {
    fixture = new HorizonLedgerFixture();
  });

  describe("call()", () => {
    it("returns deterministic account data for getAccount", async () => {
      const res = await fixture.call({ address: "GABCD", abi: null, method: "getAccount", args: ["GABCD"] });
      expect(res.data.id).toBe("GABCD");
      expect(res.data.sequence).toBe("1000");
      expect(res.data.balances).toEqual([{ asset_type: "native", balance: "10000000000" }]);
    });

    it("increments sequence on each getAccount call", async () => {
      await fixture.call({ address: "GA", abi: null, method: "getAccount", args: ["GA"] });
      const res = await fixture.call({ address: "GB", abi: null, method: "getAccount", args: ["GB"] });
      expect(res.data.sequence).toBe("1001");
    });

    it("returns transaction data for getTransaction", async () => {
      const res = await fixture.call({ address: "", abi: null, method: "getTransaction", args: ["txhash1"] });
      expect(res.data.hash).toBe("txhash1");
      expect(res.data.successful).toBe(true);
      expect(res.data.ledger).toBe(999);
    });

    it("returns empty records for getTransactions", async () => {
      const res = await fixture.call<any>({ address: "GA", abi: null, method: "getTransactions", args: ["GA"] });
      expect(res.data._embedded.records).toEqual([]);
    });

    it("returns latest ledger sequence for getLatestLedger", async () => {
      const res = await fixture.call<any>({ address: "", abi: null, method: "getLatestLedger", args: [] });
      expect(res.data._embedded.records[0].sequence).toBe(1000);
    });

    it("throws descriptive error for unknown method", async () => {
      await expect(
        fixture.call({ address: "", abi: null, method: "unknownMethod", args: [] }),
      ).rejects.toThrow('no default response for method "unknownMethod"');
    });
  });

  describe("sendTransaction()", () => {
    it("returns a fixture transaction hash", async () => {
      const res = await fixture.sendTransaction({ address: "GA", abi: null, method: "submitTransaction", args: ["xdr"] });
      expect(res.hash).toMatch(/^fixture-tx-/);
    });

    it("wait() returns transaction details", async () => {
      const res = await fixture.sendTransaction({ address: "GA", abi: null, method: "submitTransaction", args: ["xdr"] });
      const tx = await res.wait();
      expect(tx.successful).toBe(true);
    });

    it("throws for unknown send method", async () => {
      await expect(
        fixture.sendTransaction({ address: "", abi: null, method: "unknown", args: [] }),
      ).rejects.toThrow('no default response for method "unknown"');
    });
  });

  describe("submitPayout()", () => {
    it("returns transaction result", async () => {
      const res = await fixture.submitPayout("GA", "xdr");
      expect(res.hash).toMatch(/^fixture-tx-/);
    });
  });

  describe("submitMemoTransaction()", () => {
    it("returns transaction result", async () => {
      const res = await fixture.submitMemoTransaction("a".repeat(64));
      expect(res.hash).toMatch(/^fixture-tx-/);
    });
  });

  describe("getTransactionMemo()", () => {
    it("returns memo from transaction lookup", async () => {
      const memo = await fixture.getTransactionMemo("txhash");
      expect(memo.hash).toBe("txhash");
      expect(memo.memo).toBe("");
    });
  });

  describe("getAccountSequence()", () => {
    it("returns sequence as string", async () => {
      const seq = await fixture.getAccountSequence("GA");
      expect(seq).toBe("1000");
    });
  });

  describe("sendTransactionWithSequenceRecovery()", () => {
    it("returns transaction result", async () => {
      const res = await fixture.sendTransactionWithSequenceRecovery("xdr", "GA", async (s) => s);
      expect(res.hash).toMatch(/^fixture-tx-/);
    });
  });

  describe("getTransactionsPaged()", () => {
    it("returns empty collection", async () => {
      const res = await fixture.getTransactionsPaged("GA");
      expect(res.data._embedded.records).toEqual([]);
    });
  });

  describe("fetchAllTransactionsPaged()", () => {
    it("returns empty array", async () => {
      const records = await fixture.fetchAllTransactionsPaged("GA");
      expect(records).toEqual([]);
    });
  });

  describe("findPathPaymentQuote()", () => {
    it("returns a valid quote", async () => {
      const quote = await fixture.findPathPaymentQuote({
        sourceAsset: { asset_type: "native" },
        sourceAmount: "100",
        destinationAsset: { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "G" },
      });
      expect(quote.quoteId).toMatch(/^fixture-quote-/);
      expect(quote.sourceAmount).toBe("1.0000000");
      expect(quote.destinationAmount).toBe("0.9995000");
      expect(quote.maxSlippageTolerancePercent).toBe(0.5);
    });
  });

  describe("seed()", () => {
    it("overrides default response", async () => {
      fixture.seed("getAccount", { data: { custom: true }, blockNumber: 0 });
      const res = await fixture.call({ address: "GA", abi: null, method: "getAccount", args: ["GA"] });
      expect(res.data).toEqual({ custom: true });
    });
  });

  describe("seedCallback()", () => {
    it("uses callback to generate response", async () => {
      fixture.seedCallback("getAccount", (args) => ({
        data: { id: args[0], called: true },
        blockNumber: 0,
      }));
      const res = await fixture.call({ address: "GX", abi: null, method: "getAccount", args: ["GX"] });
      expect(res.data.id).toBe("GX");
      expect(res.data.called).toBe(true);
    });
  });

  describe("calls tracking", () => {
    it("records every method call", async () => {
      await fixture.call({ address: "GA", abi: null, method: "getAccount", args: ["GA"] });
      await fixture.sendTransaction({ address: "", abi: null, method: "submitTransaction", args: ["xdr"] });
      expect(fixture.calls).toHaveLength(2);
      expect(fixture.calls[0].method).toBe("getAccount");
      expect(fixture.calls[1].method).toBe("submitTransaction");
    });
  });

  describe("reset()", () => {
    it("clears all state", async () => {
      fixture.seed("getAccount", { data: {}, blockNumber: 0 });
      await fixture.call({ address: "GA", abi: null, method: "getAccount", args: ["GA"] });
      fixture.reset();
      const res = await fixture.call({ address: "GA", abi: null, method: "getAccount", args: ["GA"] });
      expect(res.data.sequence).toBe("1000");
      expect(fixture.calls).toHaveLength(1);
    });
  });

  describe("currentSequence()", () => {
    it("returns the current sequence counter", async () => {
      expect(fixture.currentSequence()).toBe(1000);
      await fixture.call({ address: "GA", abi: null, method: "getAccount", args: ["GA"] });
      expect(fixture.currentSequence()).toBe(1001);
    });
  });
});
