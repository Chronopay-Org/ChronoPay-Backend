import { MerkleTreeService, merkleTreeService, MerkleProofStep } from "./merkleTree.service.js";
import { HorizonContractClient } from "../clients/horizon-contract-client.js";

export interface InputEvidenceItem {
  id: string;
  content: string | Buffer;
  disputeId?: string;
}

export interface AnchoredEvidenceItem {
  id: string;
  disputeId?: string;
  content: string;
  leafHash: string;
  leafIndex: number;
  proof: MerkleProofStep[];
  merkleRoot: string;
  txId: string;
  anchoredAt: string;
}

export interface EvidenceBatch {
  merkleRoot: string;
  items: Array<{
    id: string;
    disputeId?: string;
    content: string;
    leafHash: string;
    leafIndex: number;
    proof: MerkleProofStep[];
  }>;
}

/**
 * Service orchestrating dispute evidence batching, Merkle root calculation,
 * Stellar Horizon memo transaction anchoring, and evidence proof verification.
 */
export class DisputeEvidenceAnchorService {
  private readonly merkleService: MerkleTreeService;

  constructor(merkleService: MerkleTreeService = merkleTreeService) {
    this.merkleService = merkleService;
  }

  /**
   * Prepares a Merkle tree batch from input evidence items without submitting to chain.
   */
  public createBatch(evidenceItems: InputEvidenceItem[]): EvidenceBatch {
    if (!evidenceItems || evidenceItems.length === 0) {
      throw new Error("Cannot create batch from empty evidence list");
    }

    const contents = evidenceItems.map((item) => item.content);
    const treeResult = this.merkleService.buildTree(contents);

    const items = evidenceItems.map((item, index) => {
      const proofResult = this.merkleService.getProof(contents, index);
      const strContent = typeof item.content === "string" ? item.content : item.content.toString("utf-8");
      return {
        id: item.id,
        disputeId: item.disputeId,
        content: strContent,
        leafHash: proofResult.leaf,
        leafIndex: index,
        proof: proofResult.proof,
      };
    });

    return {
      merkleRoot: treeResult.root,
      items,
    };
  }

  /**
   * Anchors a batch of dispute evidence items on Stellar via a Horizon memo transaction.
   *
   * @param evidenceItems Array of evidence items to batch and anchor.
   * @param horizonClient Horizon contract client used to submit memo transaction.
   * @returns Array of AnchoredEvidenceItem records complete with txId and leaf proofs.
   */
  public async anchorBatch(
    evidenceItems: InputEvidenceItem[],
    horizonClient: HorizonContractClient,
  ): Promise<AnchoredEvidenceItem[]> {
    const batch = this.createBatch(evidenceItems);

    let txResult;
    try {
      txResult = await horizonClient.submitMemoTransaction(batch.merkleRoot);
    } catch (err: any) {
      throw new Error(`Evidence anchor transaction failed: ${err.message || String(err)}`);
    }

    const anchoredAt = new Date().toISOString();

    return batch.items.map((item) => ({
      ...item,
      merkleRoot: batch.merkleRoot,
      txId: txResult.hash,
      anchoredAt,
    }));
  }

  /**
   * Off-chain verification: Checks whether an evidence payload matches a Merkle proof against a Merkle root.
   */
  public verifyEvidenceProof(content: string | Buffer, proof: MerkleProofStep[], merkleRoot: string): boolean {
    return this.merkleService.verifyEvidence(content, proof, merkleRoot);
  }

  /**
   * On-chain verification: Fetches the transaction memo from Horizon using `txId` and checks:
   * 1. The local evidence proof reconstructs to the expected Merkle root.
   * 2. The transaction memo on Stellar matches the Merkle root.
   */
  public async verifyEvidenceOnChain(
    content: string | Buffer,
    proof: MerkleProofStep[],
    txId: string,
    horizonClient: HorizonContractClient,
  ): Promise<{ isValid: boolean; reason?: string; merkleRoot?: string }> {
    let txData;
    try {
      txData = await horizonClient.getTransactionMemo(txId);
    } catch (err: any) {
      return { isValid: false, reason: `Failed to retrieve transaction from Horizon: ${err.message}` };
    }

    if (!txData) {
      return { isValid: false, reason: "Transaction not found on chain" };
    }

    // Stellar memo hash or memo field check
    const chainMemo = (txData.memo || "").toLowerCase();

    // Verify local evidence proof against the on-chain memo hash (or target root)
    if (!chainMemo) {
      return { isValid: false, reason: "Transaction contains no memo hash" };
    }

    const isProofValid = this.merkleService.verifyEvidence(content, proof, chainMemo);
    if (!isProofValid) {
      return { isValid: false, reason: "Evidence leaf proof does not match on-chain memo root hash" };
    }

    return { isValid: true, merkleRoot: chainMemo };
  }
}

export const disputeEvidenceAnchorService = new DisputeEvidenceAnchorService();
