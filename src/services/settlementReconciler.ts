import { EventEmitter } from "node:events";
import { HorizonContractClient } from "../clients/horizon-contract-client.js";
import { settlementsPendingFinality } from "../metrics.js";
import { logger } from "../utils/logger.js";

export interface Settlement {
  transactionId: string;
  eventType: string;
  amount: number;
  timestamp: number;
  status: "pending_finality" | "payout_ready" | "failed" | "reorg_flagged";
  ledgerNumber?: number;
  confirmations: number;
  attempts: number;
  lastPolledAt?: number;
  forkAlertTriggered?: boolean;
}

export const _settlements = new Map<string, Settlement>();
export const settlementEvents = new EventEmitter();

export class SettlementReconciler {
  private readonly horizonClient: HorizonContractClient;
  private readonly minConfirmations: number;
  private readonly maxAttempts: number;
  private isRunning: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;
  private pollIntervalMs: number;

  constructor(
    horizonClient: HorizonContractClient,
    options: {
      minConfirmations?: number;
      maxAttempts?: number;
      pollIntervalMs?: number;
    } = {},
  ) {
    this.horizonClient = horizonClient;
    this.minConfirmations = options.minConfirmations ?? Number(process.env.MIN_LEDGER_CONFIRMATIONS || 3);
    this.maxAttempts = options.maxAttempts ?? 5;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
  }

  /**
   * Starts the background reconciliation polling worker.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.intervalId = setInterval(() => {
      void this.reconcile();
    }, this.pollIntervalMs);
  }

  /**
   * Stops the background reconciliation polling worker.
   */
  stop(): void {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Scans all settlements and updates their states based on Horizon chain data.
   */
  async reconcile(): Promise<void> {
    const activeSettlements = Array.from(_settlements.values()).filter(
      (s) => s.status === "pending_finality" || s.status === "payout_ready",
    );

    if (activeSettlements.length === 0) {
      settlementsPendingFinality.set(0);
      return;
    }

    // 1. Update pending finality metric
    const pendingCount = activeSettlements.filter((s) => s.status === "pending_finality").length;
    settlementsPendingFinality.set(pendingCount);

    // 2. Fetch the latest ledger sequence number
    let latestLedger: number;
    try {
      const ledgerResponse = await this.horizonClient.call<any>({
        address: "",
        abi: [],
        method: "getLatestLedger",
        args: [],
      });
      latestLedger = ledgerResponse.data._embedded.records[0].sequence;
    } catch (error: any) {
      logger.warn({ error: error.message }, "SettlementReconciler failed to fetch latest ledger from Horizon. Skipping loop.");
      return;
    }

    // 3. Reconcile each active settlement
    for (const settlement of activeSettlements) {
      // Check exponential backoff delay based on attempts
      const backoffDelay = Math.pow(2, settlement.attempts) * 1000; // exponential backoff in ms
      const now = Date.now();
      if (
        settlement.status === "pending_finality" &&
        settlement.lastPolledAt &&
        now - settlement.lastPolledAt < backoffDelay
      ) {
        continue;
      }

      settlement.lastPolledAt = now;

      try {
        // Query the specific transaction from Horizon
        const txResponse = await this.horizonClient.call<any>({
          address: "",
          abi: [],
          method: "getTransaction",
          args: [settlement.transactionId],
        });

        const tx = txResponse.data;
        if (!tx.successful) {
          // If transaction exists but failed, mark settlement as failed immediately
          settlement.status = "failed";
          _settlements.set(settlement.transactionId, settlement);
          continue;
        }

        const txLedger = tx.ledger;
        const confirmations = latestLedger - txLedger + 1;

        settlement.ledgerNumber = txLedger;
        settlement.confirmations = confirmations >= 0 ? confirmations : 0;

        if (settlement.confirmations >= this.minConfirmations) {
          settlement.status = "payout_ready";
        }

        _settlements.set(settlement.transactionId, settlement);
      } catch (error: any) {
        const isNotFound = error.statusCode === 404 || error.message.includes("404") || error.message.includes("not found");

        if (isNotFound) {
          if (settlement.status === "payout_ready") {
            // CRITICAL: A transaction previously marked payout_ready has disappeared! Fork/reorg detected.
            settlement.status = "reorg_flagged";
            _settlements.set(settlement.transactionId, settlement);

            if (!settlement.forkAlertTriggered) {
              settlement.forkAlertTriggered = true;
              logger.fatal(
                { settlementId: settlement.transactionId },
                `CRITICAL: Chain fork/reorg detected! Settlement previously payout_ready has disappeared from Horizon.`,
              );
              settlementEvents.emit("alert", {
                type: "FORK_DETECTED",
                settlementId: settlement.transactionId,
                message: `Stellar transaction ${settlement.transactionId} vanished from the chain after reaching finality status.`,
              });
            }
          } else {
            // Standard missing transaction during pending finality phase: increment attempts
            settlement.attempts += 1;
            if (settlement.attempts >= this.maxAttempts) {
              settlement.status = "failed";
            }
            _settlements.set(settlement.transactionId, settlement);
          }
        } else {
          logger.warn(
            { transactionId: settlement.transactionId, error: error.message },
            "Transient error querying transaction from Horizon. Retrying next loop.",
          );
        }
      }
    }

    // Refresh pending count metric after processing
    const updatedPendingCount = Array.from(_settlements.values()).filter(
      (s) => s.status === "pending_finality",
    ).length;
    settlementsPendingFinality.set(updatedPendingCount);
  }
}
