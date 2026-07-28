import { MerkleTreeService, MerkleProofStep } from "../merkleTree.service.js";

describe("MerkleTreeService", () => {
  let merkleService: MerkleTreeService;

  beforeEach(() => {
    merkleService = new MerkleTreeService();
  });

  describe("hashLeaf and hashNode", () => {
    it("produces deterministic SHA-256 hex digest for leaf with 0x00 prefix", () => {
      const h1 = merkleService.hashLeaf("evidence-content-1");
      const h2 = merkleService.hashLeaf("evidence-content-1");
      const h3 = merkleService.hashLeaf("evidence-content-2");

      expect(h1).toBe(h2);
      expect(h1).not.toBe(h3);
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
    });

    it("accepts Buffer input for hashLeaf", () => {
      const buf = Buffer.from("buffer-evidence", "utf-8");
      const hashStr = merkleService.hashLeaf("buffer-evidence");
      const hashBuf = merkleService.hashLeaf(buf);

      expect(hashBuf).toBe(hashStr);
    });

    it("produces deterministic hash for node with 0x01 prefix", () => {
      const left = merkleService.hashLeaf("leaf-left");
      const right = merkleService.hashLeaf("leaf-right");
      const nodeHash = merkleService.hashNode(left, right);

      expect(nodeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(nodeHash).not.toBe(left);
      expect(nodeHash).not.toBe(right);
    });
  });

  describe("buildTree", () => {
    it("handles empty items list", () => {
      const result = merkleService.buildTree([]);
      expect(result.root).toBe("00".repeat(32));
      expect(result.leaves).toEqual([]);
      expect(result.tree).toEqual([["00".repeat(32)]]);
    });

    it("builds tree for single item", () => {
      const result = merkleService.buildTree(["item-1"]);
      expect(result.leaves.length).toBe(1);
      expect(result.root).toBe(result.leaves[0]);
    });

    it("builds tree for even number of items (2 items)", () => {
      const items = ["doc1", "doc2"];
      const result = merkleService.buildTree(items);
      const leaf0 = merkleService.hashLeaf("doc1");
      const leaf1 = merkleService.hashLeaf("doc2");

      expect(result.leaves).toEqual([leaf0, leaf1]);
      const expectedRoot = merkleService.hashNode(leaf0, leaf1);
      expect(result.root).toBe(expectedRoot);
    });

    it("builds tree for odd number of items (3 items)", () => {
      const items = ["doc1", "doc2", "doc3"];
      const result = merkleService.buildTree(items);

      const leaf0 = merkleService.hashLeaf("doc1");
      const leaf1 = merkleService.hashLeaf("doc2");
      const leaf2 = merkleService.hashLeaf("doc3");

      const node01 = merkleService.hashNode(leaf0, leaf1);
      const node22 = merkleService.hashNode(leaf2, leaf2); // odd trailing node paired with itself
      const expectedRoot = merkleService.hashNode(node01, node22);

      expect(result.root).toBe(expectedRoot);
    });

    it("supports pre-hashed leaves", () => {
      const h1 = merkleService.hashLeaf("doc1");
      const h2 = merkleService.hashLeaf("doc2");
      const result = merkleService.buildTree([h1, h2], true);

      expect(result.leaves).toEqual([h1, h2]);
      expect(result.root).toBe(merkleService.hashNode(h1, h2));
    });
  });

  describe("getProof and verifyProof", () => {
    it("throws error for out of bounds leaf index", () => {
      expect(() => merkleService.getProof(["doc1"], -1)).toThrow("out of bounds");
      expect(() => merkleService.getProof(["doc1"], 5)).toThrow("out of bounds");
    });

    it("generates and verifies proof for single item batch", () => {
      const items = ["doc1"];
      const proofResult = merkleService.getProof(items, 0);

      expect(proofResult.leafIndex).toBe(0);
      expect(proofResult.root).toBe(proofResult.leaf);

      const isValid = merkleService.verifyProof(proofResult.leaf, proofResult.proof, proofResult.root);
      expect(isValid).toBe(true);
    });

    it("generates and verifies valid proofs for all leaves in a 4-item tree", () => {
      const items = ["docA", "docB", "docC", "docD"];
      const treeResult = merkleService.buildTree(items);

      for (let i = 0; i < items.length; i++) {
        const proofObj = merkleService.getProof(items, i);
        expect(proofObj.root).toBe(treeResult.root);

        const isValid = merkleService.verifyProof(proofObj.leaf, proofObj.proof, treeResult.root);
        expect(isValid).toBe(true);

        const isContentValid = merkleService.verifyEvidence(items[i], proofObj.proof, treeResult.root);
        expect(isContentValid).toBe(true);
      }
    });

    it("generates and verifies valid proofs for odd number of leaves (5 items)", () => {
      const items = ["e1", "e2", "e3", "e4", "e5"];
      const treeResult = merkleService.buildTree(items);

      for (let i = 0; i < items.length; i++) {
        const proofObj = merkleService.getProof(items, i);
        const isValid = merkleService.verifyEvidence(items[i], proofObj.proof, treeResult.root);
        expect(isValid).toBe(true);
      }
    });

    it("generates and verifies proof for large batch (100 items)", () => {
      const items = Array.from({ length: 100 }, (_, i) => `evidence-file-${i}.pdf`);
      const treeResult = merkleService.buildTree(items);

      // Verify specific items: first, middle, last
      const indicesToTest = [0, 49, 99];
      for (const idx of indicesToTest) {
        const proofObj = merkleService.getProof(items, idx);
        const isValid = merkleService.verifyEvidence(items[idx], proofObj.proof, treeResult.root);
        expect(isValid).toBe(true);
      }
    });

    it("returns false when evidence content is tampered with", () => {
      const items = ["doc1", "doc2"];
      const proofObj = merkleService.getProof(items, 0);

      const isValid = merkleService.verifyEvidence("tampered-doc1", proofObj.proof, proofObj.root);
      expect(isValid).toBe(false);
    });

    it("returns false when proof step is altered", () => {
      const items = ["doc1", "doc2"];
      const proofObj = merkleService.getProof(items, 0);
      const tamperedProof: MerkleProofStep[] = [
        { position: proofObj.proof[0].position, hash: "00".repeat(32) },
      ];

      const isValid = merkleService.verifyProof(proofObj.leaf, tamperedProof, proofObj.root);
      expect(isValid).toBe(false);
    });

    it("returns false when proof step position is flipped", () => {
      const items = ["doc1", "doc2"];
      const proofObj = merkleService.getProof(items, 0);
      const tamperedProof: MerkleProofStep[] = [
        { position: proofObj.proof[0].position === "left" ? "right" : "left", hash: proofObj.proof[0].hash },
      ];

      const isValid = merkleService.verifyProof(proofObj.leaf, tamperedProof, proofObj.root);
      expect(isValid).toBe(false);
    });

    it("returns false when target root is empty or invalid", () => {
      const items = ["doc1"];
      const proofObj = merkleService.getProof(items, 0);

      expect(merkleService.verifyProof(proofObj.leaf, proofObj.proof, "")).toBe(false);
      expect(merkleService.verifyProof(proofObj.leaf, proofObj.proof, "wrong-root")).toBe(false);
      expect(merkleService.verifyProof("", proofObj.proof, proofObj.root)).toBe(false);
    });
  });
});
