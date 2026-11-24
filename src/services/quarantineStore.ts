import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";
import {
  InMemoryPayoutQuarantineRepository,
  type PayoutQuarantineEntry,
  type PayoutQuarantineRepository,
  type RecordPayoutFailureInput,
  type ReleasePayoutQuarantineOptions,
} from "../repositories/payoutQuarantineRepository.js";
import { defaultPgPayoutQuarantineRepository } from "../repositories/pgPayoutQuarantineRepository.js";

/** Simple in-memory store for quarantine intents. */
export class QuarantineStore {
  private readonly store = new Map<string, any>();

  /** Add a new quarantine entry and return its id. */
  add(data: any): string {
    const id = uuidv4();
    this.store.set(id, data);
    return id;
  }

  /** Retrieve an entry by id. */
  get(id: string): any | undefined {
    return this.store.get(id);
  }

  /** Delete an entry. */
  delete(id: string): void {
    this.store.delete(id);
  }
}

export type {
  PayoutQuarantineEntry,
  PayoutQuarantineStatus,
  RecordPayoutFailureInput,
  ReleasePayoutQuarantineOptions,
} from "../repositories/payoutQuarantineRepository.js";

export interface RecordPayoutFailureResult extends PayoutQuarantineEntry {
  quarantined: boolean;
}

export const payoutQuarantineEvents = new EventEmitter();

export class PayoutQuarantineService {
  private readonly repository: PayoutQuarantineRepository;

  constructor(
    private readonly options: {
      defaultThreshold?: number;
      repository?: PayoutQuarantineRepository;
    } = {},
  ) {
    this.repository =
      options.repository ?? new InMemoryPayoutQuarantineRepository();
  }

  async recordFailure(
    input: RecordPayoutFailureInput,
  ): Promise<RecordPayoutFailureResult> {
    const threshold =
      input.threshold ?? this.options.defaultThreshold ?? 3;
    const { entry, newlyQuarantined } = await this.repository.upsert({
      ...input,
      threshold,
      operationId: uuidv4(),
    });

    if (newlyQuarantined) {
      payoutQuarantineEvents.emit("alert", {
        type: "PAYOUT_QUARANTINED",
        payoutId: input.payoutId,
        supplierId: input.supplierId,
        totalFailures: entry.totalFailures,
        threshold,
        quarantineReason: entry.quarantineReason,
      });
    }

    return { ...entry, quarantined: newlyQuarantined };
  }

  async release(
    payoutId: string,
    options: ReleasePayoutQuarantineOptions = {},
  ): Promise<boolean> {
    return this.repository.release(payoutId, options);
  }

  async isQuarantined(payoutId: string): Promise<boolean> {
    return (await this.repository.get(payoutId))?.status === "quarantined";
  }

  get(payoutId: string): Promise<PayoutQuarantineEntry | undefined> {
    return this.repository.get(payoutId);
  }

  list(): Promise<PayoutQuarantineEntry[]> {
    return this.repository.list();
  }

  reset(): void {
    if (!this.repository.reset) {
      throw new Error("Reset is only supported by the in-memory quarantine repository");
    }
    this.repository.reset();
  }
}

let defaultPayoutQuarantineService: PayoutQuarantineService | null = null;

export function getPayoutQuarantineService(): PayoutQuarantineService {
  if (!defaultPayoutQuarantineService) {
    defaultPayoutQuarantineService = new PayoutQuarantineService({
      repository: defaultPgPayoutQuarantineRepository,
    });
  }
  return defaultPayoutQuarantineService;
}

export function resetPayoutQuarantineState(): void {
  defaultPayoutQuarantineService = new PayoutQuarantineService({
    repository: new InMemoryPayoutQuarantineRepository(),
  });
}
