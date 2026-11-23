import { createHash } from "crypto";

export interface MerkleProofStep {
  position: "left" | "right";
  hash: string;
}

export interface MerkleProof {
  leaf: string;
  leafIndex: number;
  proof: MerkleProofStep[];
  root: string;
}

export interface MerkleTreeResult {
  root: string;
  leaves: string[];
  tree: string[][];
}

/**
 * Service to compute Merkle tree root hashes, inclusion proofs,
 * and verify proofs for dispute evidence tampering protection.
 *
 * Uses domain separation to prevent second-preimage attacks:
 *   - Leaf hash:     sha256(0x00 + payload)
 *   - Internal node: sha256(0x01 + left_hash + right_hash)
 */
export class MerkleTreeService {
  /**
   * Computes SHA-256 hex digest of a Buffer or string with domain prefix.
   */
  public hashLeaf(content: string | Buffer): string {
    const bufferContent = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    const hasher = createHash("sha256");
    hasher.update(Buffer.from([0x00])); // Leaf domain prefix
    hasher.update(bufferContent);
    return hasher.digest("hex");
  }

  /**
   * Computes SHA-256 hex digest of two child hashes with internal node domain prefix.
   */
  public hashNode(leftHex: string, rightHex: string): string {
    const hasher = createHash("sha256");
    hasher.update(Buffer.from([0x01])); // Node domain prefix
    hasher.update(Buffer.from(leftHex, "hex"));
    hasher.update(Buffer.from(rightHex, "hex"));
    return hasher.digest("hex");
  }

  /**
   * Constructs a Merkle tree from an array of raw evidence payloads or pre-computed leaf hashes.
   *
   * @param items Array of raw evidence content strings/buffers OR pre-hashed leaf hex strings.
   * @param isPreHashed Set to true if items are already domain-hashed leaf strings.
   */
  public buildTree(items: Array<string | Buffer>, isPreHashed = false): MerkleTreeResult {
    if (!items || items.length === 0) {
      // Empty tree has an all-zero hash root
      const emptyRoot = "00".repeat(32);
      return {
        root: emptyRoot,
        leaves: [],
        tree: [[emptyRoot]],
      };
    }

    const leaves: string[] = items.map((item) => {
      if (isPreHashed && typeof item === "string") {
        return item;
      }
      return this.hashLeaf(item);
    });

    const tree: string[][] = [leaves];
    let currentLevel = leaves;

    while (currentLevel.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        // If odd number of nodes in level, duplicate the last node
        const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : left;
        nextLevel.push(this.hashNode(left, right));
      }
      tree.push(nextLevel);
      currentLevel = nextLevel;
    }

    const root = currentLevel[0];
    return {
      root,
      leaves,
      tree,
    };
  }

  /**
   * Generates a Merkle inclusion proof for a leaf at a given index.
   */
  public getProof(items: Array<string | Buffer>, index: number, isPreHashed = false): MerkleProof {
    const treeResult = this.buildTree(items, isPreHashed);
    const { leaves, tree, root } = treeResult;

    if (index < 0 || index >= leaves.length) {
      throw new Error(`Leaf index ${index} out of bounds for tree with ${leaves.length} leaves.`);
    }

    const proof: MerkleProofStep[] = [];
    let currentIndex = index;

    for (let levelIndex = 0; levelIndex < tree.length - 1; levelIndex++) {
      const level = tree[levelIndex];
      const isRightChild = currentIndex % 2 === 1;
      const siblingIndex = isRightChild ? currentIndex - 1 : currentIndex + 1;

      if (siblingIndex < level.length) {
        proof.push({
          position: isRightChild ? "left" : "right",
          hash: level[siblingIndex],
        });
      } else {
        // Trailing odd leaf paired with itself
        proof.push({
          position: "right",
          hash: level[currentIndex],
        });
      }

      currentIndex = Math.floor(currentIndex / 2);
    }

    return {
      leaf: leaves[index],
      leafIndex: index,
      proof,
      root,
    };
  }

  /**
   * Verifies a Merkle inclusion proof against a target root hash.
   *
   * @param leaf The leaf hash to verify.
   * @param proof The inclusion proof steps.
   * @param targetRoot The expected Merkle root.
   */
  public verifyProof(leaf: string, proof: MerkleProofStep[], targetRoot: string): boolean {
    if (!leaf || !targetRoot) return false;

    let computedHash = leaf.toLowerCase();
    const cleanTarget = targetRoot.toLowerCase();

    for (const step of proof) {
      const stepHash = step.hash.toLowerCase();
      if (step.position === "left") {
        computedHash = this.hashNode(stepHash, computedHash);
      } else {
        computedHash = this.hashNode(computedHash, stepHash);
      }
    }

    return computedHash === cleanTarget;
  }

  /**
   * Helper to hash raw evidence content and verify its inclusion in target root with proof.
   */
  public verifyEvidence(content: string | Buffer, proof: MerkleProofStep[], targetRoot: string): boolean {
    const leaf = this.hashLeaf(content);
    return this.verifyProof(leaf, proof, targetRoot);
  }
}

export const merkleTreeService = new MerkleTreeService();
