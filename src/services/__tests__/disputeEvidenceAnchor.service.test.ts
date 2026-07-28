import { jest } from "@jest/globals";
import {
  DisputeEvidenceAnchorService,
  disputeEvidenceAnchorService,
} from "../disputeEvidenceAnchor.service.js";
import { HorizonContractClient } from "../../clients/horizon-contract-client.js";

describe("DisputeEvidenceAnchorService", () => {
  let anchorService: DisputeEvidenceAnchorService;
  let mockHorizonClient: jest.Mocked<HorizonContractClient>;

  beforeEach(() => {
    anchorService = new DisputeEvidenceAnchorService();
    mockHorizonClient = {
      submitMemoTransaction: jest.fn(),
      getTransactionMemo: jest.fn(),
      call: jest.fn(),
      sendTransaction: jest.fn(),
    } as unknown as jest.Mocked<HorizonContractClient>;
  });

  describe("createBatch", () => {
    it("throws error when evidence items array is empty", () => {
      expect(() => anchorService.createBatch([])).toThrow("Cannot create batch from empty evidence list");
    });

    it("creates an evidence batch with Merkle root and individual leaf proofs", () => {
      const items = [
        { id: "ev-1", content: "invoice_1001.pdf", disputeId: "disp-100" },
        { id: "ev-2", content: "shipping_receipt.png", disputeId: "disp-100" },
      ];

      const batch = anchorService.createBatch(items);

      expect(batch.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
      expect(batch.items.length).toBe(2);

      expect(batch.items[0].id).toBe("ev-1");
      expect(batch.items[0].leafIndex).toBe(0);
      expect(batch.items[0].content).toBe("invoice_1001.pdf");
      expect(batch.items[0].proof.length).toBe(1);

      expect(batch.items[1].id).toBe("ev-2");
      expect(batch.items[1].leafIndex).toBe(1);
      expect(batch.items[1].content).toBe("shipping_receipt.png");
    });

    it("handles Buffer content in batch items", () => {
      const bufContent = Buffer.from("raw-evidence-bytes", "utf-8");
      const items = [{ id: "ev-buf", content: bufContent }];

      const batch = anchorService.createBatch(items);
      expect(batch.items[0].content).toBe("raw-evidence-bytes");
      expect(batch.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("anchorBatch", () => {
    it("successfully submits memo transaction to Horizon and returns anchored records", async () => {
      const items = [
        { id: "ev-1", content: "contract.pdf", disputeId: "disp-1" },
        { id: "ev-2", content: "email_log.txt", disputeId: "disp-1" },
      ];
      const fakeTxHash = "tx_hash_1234567890abcdef";

      mockHorizonClient.submitMemoTransaction.mockResolvedValueOnce({
        hash: fakeTxHash,
        wait: jest.fn<() => Promise<any>>().mockResolvedValue({ ledger: 100 }),
      });

      const result = await anchorService.anchorBatch(items, mockHorizonClient);

      expect(result.length).toBe(2);
      expect(result[0].txId).toBe(fakeTxHash);
      expect(result[0].merkleRoot).toMatch(/^[0-9a-f]{64}$/);
      expect(result[0].proof).toBeDefined();
      expect(result[0].anchoredAt).toBeDefined();

      expect(mockHorizonClient.submitMemoTransaction).toHaveBeenCalledWith(result[0].merkleRoot);
    });

    it("handles transaction failure when Horizon submission fails", async () => {
      const items = [{ id: "ev-1", content: "file.pdf" }];
      mockHorizonClient.submitMemoTransaction.mockRejectedValueOnce(new Error("Horizon network timeout"));

      await expect(anchorService.anchorBatch(items, mockHorizonClient)).rejects.toThrow(
        "Evidence anchor transaction failed: Horizon network timeout",
      );
    });
  });

  describe("verifyEvidenceProof (off-chain)", () => {
    it("returns true for unmodified evidence and matching proof", () => {
      const items = [
        { id: "ev-1", content: "evidence-file-1" },
        { id: "ev-2", content: "evidence-file-2" },
      ];
      const batch = anchorService.createBatch(items);

      const isValid = anchorService.verifyEvidenceProof(
        "evidence-file-1",
        batch.items[0].proof,
        batch.merkleRoot,
      );
      expect(isValid).toBe(true);
    });

    it("returns false for altered evidence content", () => {
      const items = [{ id: "ev-1", content: "genuine-file" }, { id: "ev-2", content: "file-2" }];
      const batch = anchorService.createBatch(items);

      const isValid = anchorService.verifyEvidenceProof(
        "altered-file",
        batch.items[0].proof,
        batch.merkleRoot,
      );
      expect(isValid).toBe(false);
    });

    it("returns false for wrong proof", () => {
      const items = [{ id: "ev-1", content: "file-1" }, { id: "ev-2", content: "file-2" }];
      const batch = anchorService.createBatch(items);

      const isValid = anchorService.verifyEvidenceProof(
        "file-1",
        batch.items[1].proof, // wrong leaf's proof
        batch.merkleRoot,
      );
      expect(isValid).toBe(false);
    });
  });

  describe("verifyEvidenceOnChain", () => {
    it("returns isValid: true when Horizon tx memo matches leaf proof", async () => {
      const items = [
        { id: "ev-1", content: "evidence_a.txt" },
        { id: "ev-2", content: "evidence_b.txt" },
      ];
      const batch = anchorService.createBatch(items);

      mockHorizonClient.getTransactionMemo.mockResolvedValueOnce({
        hash: "tx_123",
        memo: batch.merkleRoot,
        memo_type: "hash",
      });

      const result = await anchorService.verifyEvidenceOnChain(
        "evidence_a.txt",
        batch.items[0].proof,
        "tx_123",
        mockHorizonClient,
      );

      expect(result.isValid).toBe(true);
      expect(result.merkleRoot).toBe(batch.merkleRoot);
    });

    it("returns isValid: false when Horizon request fails", async () => {
      mockHorizonClient.getTransactionMemo.mockRejectedValueOnce(new Error("404 Not Found"));

      const result = await anchorService.verifyEvidenceOnChain(
        "evidence.txt",
        [],
        "invalid_tx",
        mockHorizonClient,
      );

      expect(result.isValid).toBe(false);
      expect(result.reason).toContain("Failed to retrieve transaction from Horizon: 404 Not Found");
    });

    it("returns isValid: false when transaction returns null/undefined", async () => {
      mockHorizonClient.getTransactionMemo.mockResolvedValueOnce(null as any);

      const result = await anchorService.verifyEvidenceOnChain(
        "evidence.txt",
        [],
        "tx_null",
        mockHorizonClient,
      );

      expect(result.isValid).toBe(false);
      expect(result.reason).toBe("Transaction not found on chain");
    });

    it("returns isValid: false when transaction has no memo", async () => {
      mockHorizonClient.getTransactionMemo.mockResolvedValueOnce({
        hash: "tx_no_memo",
      });

      const result = await anchorService.verifyEvidenceOnChain(
        "evidence.txt",
        [],
        "tx_no_memo",
        mockHorizonClient,
      );

      expect(result.isValid).toBe(false);
      expect(result.reason).toBe("Transaction contains no memo hash");
    });

    it("returns isValid: false when proof does not match on-chain memo hash", async () => {
      const items = [{ id: "ev-1", content: "real-file" }];
      const batch = anchorService.createBatch(items);

      // On-chain memo has a completely different hash
      const differentRoot = "aa".repeat(32);
      mockHorizonClient.getTransactionMemo.mockResolvedValueOnce({
        hash: "tx_diff",
        memo: differentRoot,
      });

      const result = await anchorService.verifyEvidenceOnChain(
        "real-file",
        batch.items[0].proof,
        "tx_diff",
        mockHorizonClient,
      );

      expect(result.isValid).toBe(false);
      expect(result.reason).toContain("Evidence leaf proof does not match on-chain memo root hash");
    });
  });

  describe("singleton export", () => {
    it("exports disputeEvidenceAnchorService instance", () => {
      expect(disputeEvidenceAnchorService).toBeInstanceOf(DisputeEvidenceAnchorService);
    });
  });
});
