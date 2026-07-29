import { EventEmitter } from "node:events";
import { HorizonContractClient } from "../clients/horizon-contract-client.js";
import { settlementsPendingFinality } from "../metrics.js";
import { getPayoutQuarantineService } from "./quarantineStore.js";
import { logger } from "../utils/logger.js";
import {
  calculatePayoutBackoffDelay,
  getProviderRetryConfig,
  isRetryable,
  type ProviderRetryConfig,
} from "../scheduler/payoutRetryPolicy.js";
import {
  payoutRetryRollup,
  resolveRetryOutcome,
} from "../scheduler/payoutRetryMetrics.js";

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
  /**
   * Provider id used to look up the per-provider retry ceiling.
   * Defaults to "default" when not supplied by the caller.
   */
  providerId?: string;
}

export type RefundSettlementStatus =
  | "pending_chain"
  | "submitted"
  | "pending_finality"
  | "settled"
  | "failed";

export interface RefundSettlementRecord {
  refundRequestId: string;
  bookingIntentId: string;
  escrowHoldId: string;
  buyerId: string;
  supplierId: string;
  grossAmountCents: number;
  platformFeeReversedCents: number;
  prepaidTaxReversedCents: number;
  netRefundCents: number;
  currency: string;
  submittedChainTxId?: string;
  settlementChainTxId?: string;
  status: RefundSettlementStatus;
  confirmations: number;
  attempts: number;
  lastPolledAt?: number;
  createdAt: number;
  submittedAt?: number;
  settledAt?: number;
  failedAt?: number;
  failureReason?: string;
}

export const _settlements = new Map<string, Settlement>();
export const _refundSettlements = new Map<string, RefundSettlementRecord>();
export const settlementEvents = new EventEmitter();
export const refundSettlementEvents = new EventEmitter();

export class SettlementReconciler {
  private readonly horizonClient: HorizonContractClient;
  private readonly minConfirmations: number;
  private isRunning: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;
  private pollIntervalMs: number;

  /**
   * Pluggable clock — overridable in tests so backoff assertions are
   * deterministic without `jest.useFakeTimers`.
   */
  private readonly _now: () => number;

  /**
   * Pluggable random source — overridable in tests to produce deterministic
   * jitter.  Defaults to `Math.random`.
   */
  private readonly _random: () => number;

  constructor(
    horizonClient: HorizonContractClient,
    options: {
      minConfirmations?: number;
      /**
       * @deprecated Pass per-provider ceiling via `providerRetryRegistry` or
       * `defaultProviderRetryConfig` instead.  Kept for backwards-compat with
       * existing tests — treated as the `maxRetries` of the default provider.
       */
      maxAttempts?: number;
      pollIntervalMs?: number;
      /**
       * Override the retry config used when a settlement has no `providerId`
       * (or its id is not found in `providerRetryRegistry`).
       */
      defaultProviderRetryConfig?: ProviderRetryConfig;
      /** @internal test-only clock override */
      _now?: () => number;
      /** @internal test-only random override */
      _random?: () => number;
    } = {},
  ) {
    this.horizonClient = horizonClient;
    this.minConfirmations = options.minConfirmations ?? Number(process.env.MIN_LEDGER_CONFIRMATIONS || 3);
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this._now = options._now ?? (() => Date.now());
    this._random = options._random ?? Math.random;

    // If the legacy maxAttempts option was passed, register a "default" provider
    // config that respects it so old callers are not broken.
    if (options.defaultProviderRetryConfig) {
      this._defaultRetryConfig = options.defaultProviderRetryConfig;
    } else if (options.maxAttempts !== undefined) {
      this._defaultRetryConfig = {
        providerId: "default",
        baseDelayMs: 1_000,
        multiplier: 2,
        maxDelayCeilingMs: 30_000,
        maxRetries: options.maxAttempts,
      };
    }
  }

  /**
   * Per-instance default retry config.  Falls back to the module-level
   * `providerRetryRegistry` if not set.
   */
  private _defaultRetryConfig: ProviderRetryConfig | undefined;

  /**
   * Resolve the retry config for a settlement, honouring:
   *   1. Per-instance default (constructor override or legacy maxAttempts)
   *   2. Module-level providerRetryRegistry keyed by settlement.providerId
   *   3. Library-wide DEFAULT_PROVIDER_RETRY_CONFIG
   */
  private resolveRetryConfig(settlement: Settlement): ProviderRetryConfig {
    const id = settlement.providerId ?? "default";
    if (this._defaultRetryConfig && id === "default") {
      return { ...this._defaultRetryConfig, providerId: id };
    }
    return getProviderRetryConfig(id);
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
      logger.warn(
        { error: error.message },
        "SettlementReconciler failed to fetch latest ledger from Horizon. Skipping loop.",
      );
      return;
    }

    // 3. Reconcile each active settlement
    for (const settlement of activeSettlements) {
      const retryCfg = this.resolveRetryConfig(settlement);

      // ── Jittered backoff gate ───────────────────────────────────────────
      // For pending_finality settlements, compute the required wait from the
      // full-jitter algorithm and skip polling if the window has not elapsed.
      if (
        settlement.status === "pending_finality" &&
        settlement.lastPolledAt !== undefined
      ) {
        const backoff = calculatePayoutBackoffDelay(
          settlement.attempts,
          retryCfg,
          this._random,
        );
        const now = this._now();
        const elapsed = now - settlement.lastPolledAt;

        if (elapsed < backoff.delayMs) {
          // Still within the backoff window — do not poll yet.
          continue;
        }
      }

      settlement.lastPolledAt = this._now();

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
          // Transaction exists but failed on-chain — mark as failed immediately.
          settlement.status = "failed";
          getPayoutQuarantineService().recordFailure({
            payoutId: settlement.transactionId,
            errorClass: "SETTLEMENT",
            errorMessage: "Settlement transaction was rejected by the network",
            threshold: Number(process.env.PAYOUT_QUARANTINE_THRESHOLD ?? 3),
          });
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
        const isNotFound =
          error.statusCode === 404 ||
          error.message.includes("404") ||
          error.message.includes("not found");

        if (isNotFound) {
          if (settlement.status === "payout_ready") {
            // CRITICAL: transaction previously payout_ready has disappeared — fork/reorg.
            settlement.status = "reorg_flagged";
            _settlements.set(settlement.transactionId, settlement);

            if (!settlement.forkAlertTriggered) {
              settlement.forkAlertTriggered = true;
              logger.fatal(
                { settlementId: settlement.transactionId },
                "CRITICAL: Chain fork/reorg detected! Settlement previously payout_ready has disappeared from Horizon.",
              );
              settlementEvents.emit("alert", {
                type: "FORK_DETECTED",
                settlementId: settlement.transactionId,
                message: `Stellar transaction ${settlement.transactionId} vanished from the chain after reaching finality status.`,
              });
            }
          } else {
            // Standard missing transaction during pending finality — increment attempts
            // and emit retry metrics before deciding whether to exhaust.
            const nextAttempt = settlement.attempts + 1;
            const exhausted = !isRetryable(nextAttempt, retryCfg);

            // Compute the backoff that WILL apply to the next attempt so we
            // can record it in metrics (even if this is the last one).
            const backoff = calculatePayoutBackoffDelay(
              nextAttempt,
              retryCfg,
              this._random,
            );
            const outcome = resolveRetryOutcome(
              backoff.capMs,
              retryCfg.maxDelayCeilingMs,
              exhausted,
            );

            payoutRetryRollup.recordAttempt(
              retryCfg.providerId,
              outcome,
              backoff.delayMs,
              backoff.capMs,
            );

            logger.warn(
              {
                transactionId: settlement.transactionId,
                attempt: nextAttempt,
                maxRetries: retryCfg.maxRetries,
                delayMs: backoff.delayMs,
                capMs: backoff.capMs,
                ceilingMs: retryCfg.maxDelayCeilingMs,
                outcome,
              },
              "Payout retry scheduled with jittered backoff",
            );

            settlement.attempts = nextAttempt;

            if (exhausted) {
              settlement.status = "failed";
              getPayoutQuarantineService().recordFailure({
                payoutId: settlement.transactionId,
                errorClass: "SETTLEMENT",
                errorMessage:
                  "Settlement failed after reaching the maximum reconciliation attempts",
                threshold: Number(process.env.PAYOUT_QUARANTINE_THRESHOLD ?? 3),
              });
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

  /**
   * Queue an escrow refund for on-chain settlement.
   * Called from SchedulingService's refund.requested event handler.
   *
   * Phase flow:
   *   pending_chain → (submit refund XDR) → submitted → pending_finality → settled
   *                                            ↘ (Horizon rejects) → failed
   *
   * Guarantees (issue #439):
   *   - Platform fee is fully reversed (not deducted from buyer refund).
   *   - Prepaid tax is fully reversed (credited back to buyer side).
   *   - The refund settlement record carries a copy of the ledger values at
   *     time of queueing so they are immutable even if upstream data changes.
   *   - Idempotent: calling twice with the same refundRequestId no-ops.
   */
  queueEscrowRefundSettlement(
    ledgerEntry: EscrowRefundLedgerEntry,
    nowMs: () => number = () => Date.now(),
  ): RefundSettlementRecord {
    const existing = _refundSettlements.get(ledgerEntry.refundRequestId);
    if (existing) {
      return existing;
    }

    const record: RefundSettlementRecord = {
      refundRequestId: ledgerEntry.refundRequestId,
      bookingIntentId: ledgerEntry.bookingIntentId,
      escrowHoldId: ledgerEntry.escrowHoldId,
      buyerId: ledgerEntry.buyerId,
      supplierId: ledgerEntry.supplierId,
      grossAmountCents: ledgerEntry.grossAmountCents,
      platformFeeReversedCents: ledgerEntry.platformFeeReversedCents,
      prepaidTaxReversedCents: ledgerEntry.prepaidTaxReversedCents,
      netRefundCents: ledgerEntry.netRefundCents,
      currency: ledgerEntry.currency,
      status: "pending_chain",
      confirmations: 0,
      attempts: 0,
      createdAt: nowMs(),
    };

    _refundSettlements.set(record.refundRequestId, record);
    refundSettlementEvents.emit("refund.queued", { record });
    return record;
  }

  /**
   * Submit the queued refund's XDR to the chain and advance its lifecycle.
   *
   * @param refundRequestId  The refund identifier to settle.
   * @param submitXdrFn      Callback that POSTs the refund XDR to Horizon
   *                         (injected so unit tests can avoid real network I/O).
   */
  async submitRefundToChain(
    refundRequestId: string,
    submitXdrFn: () => Promise<{ hash: string }>,
    nowMs: () => number = () => Date.now(),
  ): Promise<RefundSettlementRecord> {
    const record = _refundSettlements.get(refundRequestId);
    if (!record) {
      throw new Error(`Unknown refundRequestId: ${refundRequestId}`);
    }
    if (
      record.status === "settled" ||
      record.status === "submitted" ||
      record.status === "pending_finality"
    ) {
      return record;
    }

    try {
      const tx = await submitXdrFn();
      record.submittedChainTxId = tx.hash;
      record.submittedAt = nowMs();
      record.status = "submitted";
      record.attempts += 1;
      _refundSettlements.set(refundRequestId, record);
      refundSettlementEvents.emit("refund.submitted", { record, txHash: tx.hash });
      return record;
    } catch (err: unknown) {
      record.attempts += 1;
      const maxAttempts = 5;
      if (record.attempts >= maxAttempts) {
        record.status = "failed";
        record.failedAt = nowMs();
        record.failureReason = err instanceof Error ? err.message : String(err);
        _refundSettlements.set(refundRequestId, record);
        refundSettlementEvents.emit("refund.failed", { record, error: record.failureReason });
      }
      throw err;
    }
  }

  /**
   * Reconcile all active refund settlements against Horizon chain state.
   * Mirrors the flow of reconcile() but against the refund map.
   */
  async reconcileRefunds(): Promise<void> {
    const active = Array.from(_refundSettlements.values()).filter(
      (r) => r.status === "submitted" || r.status === "pending_finality",
    );
    if (active.length === 0) return;

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
      logger.warn(
        { error: error.message },
        "SettlementReconciler.refunds failed to fetch latest ledger. Skipping loop.",
      );
      return;
    }

    for (const record of active) {
      const txHash = record.submittedChainTxId ?? record.settlementChainTxId;
      if (!txHash) continue;

      record.lastPolledAt = Date.now();

      try {
        const txResponse = await this.horizonClient.call<any>({
          address: "",
          abi: [],
          method: "getTransaction",
          args: [txHash],
        });
        const tx = txResponse.data;
        if (!tx.successful) {
          record.status = "failed";
          record.failedAt = Date.now();
          record.failureReason = "Refund chain transaction rejected";
          _refundSettlements.set(record.refundRequestId, record);
          refundSettlementEvents.emit("refund.failed", { record, error: record.failureReason });
          continue;
        }

        const txLedger = tx.ledger;
        const confirmations = Math.max(0, latestLedger - txLedger + 1);
        record.confirmations = confirmations;

        if (record.status === "submitted") record.status = "pending_finality";
        if (confirmations >= this.minConfirmations) {
          record.status = "settled";
          record.settledAt = Date.now();
          record.settlementChainTxId = txHash;
          refundSettlementEvents.emit("refund.settled", { record });
        }

        _refundSettlements.set(record.refundRequestId, record);
      } catch (error: any) {
        const isNotFound =
          error.statusCode === 404 ||
          error.message?.includes("404") ||
          error.message?.includes("not found");
        if (isNotFound && record.status === "settled") {
          logger.fatal(
            { refundRequestId: record.refundRequestId },
            "CRITICAL: Settled refund chain tx disappeared (reorg). Escalate immediately.",
          );
          refundSettlementEvents.emit("refund.reorg", { record });
        }
      }
    }
  }

  /**
   * Compute the settlement amount breakdown for a refund — convenience helper
   * for audit reports.
   *
   * Verifies the invariant required by issue #439:
   *   grossAmountCents == platformFeeReversedCents + (grossAmountCents - platformFeeReversedCents)
   *   AND netRefundCents == grossAmountCents + prepaidTaxReversedCents
   *   (supplier bears the full cost; buyer is made whole including tax).
   */
  verifyRefundSettlementBreakdown(record: RefundSettlementRecord): {
    valid: boolean;
    buyerGetsCents: number;
    supplierForfeitsCents: number;
    platformForfeitsFeeCents: number;
    treasuryForfeitsTaxCents: number;
  } {
    const buyerGetsCents = record.netRefundCents;
    const supplierForfeitsCents = record.grossAmountCents;
    const platformForfeitsFeeCents = record.platformFeeReversedCents;
    const treasuryForfeitsTaxCents = record.prepaidTaxReversedCents;

    const netCheck =
      record.netRefundCents === record.grossAmountCents + record.prepaidTaxReversedCents;
    const feeCheck =
      record.platformFeeReversedCents >= 0 &&
      record.platformFeeReversedCents <= record.grossAmountCents;
    const taxCheck = record.prepaidTaxReversedCents >= 0;

    return {
      valid: netCheck && feeCheck && taxCheck,
      buyerGetsCents,
      supplierForfeitsCents,
      platformForfeitsFeeCents,
      treasuryForfeitsTaxCents,
    };
  }
}
