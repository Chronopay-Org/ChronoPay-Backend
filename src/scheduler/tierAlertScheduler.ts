import {
  SupplierTierAlertService,
  AlertEvaluationResult,
  SupplierTierAlert,
  defaultSupplierTierAlertService,
} from "../services/supplierTierAlertService.js";

export interface TierAlertSchedulerOptions {
  service?: SupplierTierAlertService;
  runIntervalMs?: number;
  onBatchComplete?: (results: AlertEvaluationResult[]) => void;
  onAlert?: (alert: SupplierTierAlert) => void;
  maxRuns?: number;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export class TierAlertScheduler {
  private service: SupplierTierAlertService;
  private runIntervalMs: number;
  private onBatchComplete?: (results: AlertEvaluationResult[]) => void;
  private onAlert?: (alert: SupplierTierAlert) => void;
  private maxRuns?: number;
  private timer: NodeJS.Timeout | null = null;
  private runCount = 0;
  private isRunning = false;

  constructor(options: TierAlertSchedulerOptions = {}) {
    this.service = options.service ?? defaultSupplierTierAlertService;
    this.runIntervalMs = options.runIntervalMs ?? DEFAULT_INTERVAL_MS;
    this.onBatchComplete = options.onBatchComplete;
    this.onAlert = options.onAlert;
    this.maxRuns = options.maxRuns;
  }

  async runOnce(): Promise<AlertEvaluationResult[]> {
    if (!this.service.isEnabled()) {
      return [];
    }

    const results = await this.service.evaluateAllSuppliers();

    for (const result of results) {
      for (const alert of result.alerts) {
        this.onAlert?.(alert);
      }
    }

    this.onBatchComplete?.(results);
    return results;
  }

  start(): void {
    if (this.timer) return;
    this.isRunning = true;

    const tick = async (): Promise<void> => {
      if (!this.isRunning) return;

      if (this.maxRuns !== undefined && this.runCount >= this.maxRuns) {
        this.stop();
        return;
      }

      try {
        this.runCount++;
        await this.runOnce();
      } catch (err) {
        console.error(
          "[tier-alert-scheduler] Batch evaluation failed:",
          err instanceof Error ? err.message : err
        );
      }

      if (this.isRunning) {
        this.timer = setTimeout(tick, this.runIntervalMs);
      }
    };

    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getRunCount(): number {
    return this.runCount;
  }

  isActive(): boolean {
    return this.isRunning;
  }
}

export function createTierAlertScheduler(
  options?: TierAlertSchedulerOptions
): TierAlertScheduler {
  return new TierAlertScheduler(options);
}
