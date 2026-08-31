import { logger } from "../utils/logger.js";
export interface HoldRecord {
  id: string;
  contractHash: string;
  status: 'pending' | 'finalized' | 'drained';
}

/**
 * EscrowDrainWorker
 * Responsible for finding finalized holds on older escrow contracts
 * and draining them (releasing/refunding) to prevent orphaning during a contract migration.
 */
export class EscrowDrainWorker {
  private readonly batchSize: number;
  private readonly oldContractHash: string | undefined;

  constructor(options: { batchSize?: number; oldContractHash?: string } = {}) {
    this.batchSize = options.batchSize || 50;
    this.oldContractHash = options.oldContractHash;
  }

  /**
   * Drain finalized holds for a specific old contract.
   * Returns the number of holds drained.
   */
  async drain(holds: HoldRecord[]): Promise<number> {
    if (!this.oldContractHash) {
      return 0; // No old contract hash provided, nothing to drain
    }

    const targetHolds = holds.filter(
      h => h.contractHash === this.oldContractHash && h.status === 'finalized'
    );

    let drainedCount = 0;
    for (const hold of targetHolds.slice(0, this.batchSize)) {
      try {
        // Idempotent drain operation
        hold.status = 'drained';
        drainedCount++;
      } catch (err) {
        // If crash occurs, we rely on idempotent nature of the drain to recover on next tick
        logger.error({ err }, `Failed to drain hold ${hold.id}`);
      }
    }

    return drainedCount;
  }
}
