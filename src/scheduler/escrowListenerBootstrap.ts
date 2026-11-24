/**
 * Escrow Event Listener Bootstrap
 * -------------------------------
 *
 * Composes `EscrowListenerOptions` from environment variables and existing
 * Redis-backed cursor/idempotency stores, then starts `runEscrowListener`
 * with a graceful-shutdown handle.
 *
 * Required env to start:
 *   - `ESCROW_LISTENER_ENABLED=true`
 *   - `ESCROW_CONTRACT_ADDRESSES=<addr1,addr2,...>` (non-empty allowlist)
 *
 * Optional env:
 *   - `ESCROW_LISTENER_INSTANCE_ID` (defaults to `os.hostname()`)
 *   - `ESCROW_LISTENER_TICK_INTERVAL_MS` (default 5000)
 *   - `ESCROW_LISTENER_PAGE_LIMIT` (default 100)
 *   - `ESCROW_LISTENER_FINALITY_DEPTH` (default 2)
 *   - `ESCROW_LISTENER_FRESHNESS_SLO_SECONDS` (default 60)
 *   - `HORIZON_URL` / `HORIZON_URLS` (first URL used for latest ledger tip)
 */

import os from "node:os";
import { logger } from "../utils/logger.js";
import { bookingIntentContainer } from "../modules/booking-intents/bookingIntentContainer.js";
import { HorizonEscrowReader } from "../services/escrowReader.js";
import type {
  GetEventsArgs,
  GetEventsResult,
  IEscrowContractClient,
  EscrowLedgerInfo,
} from "./escrowContractClient.js";
import { RedisCursorStore, type CursorStore } from "./escrowCursorStore.js";
import { RedisIdempotencyStore, type IdempotencyStore } from "./escrowIdempotencyStore.js";
import {
  runEscrowListener,
  type EscrowListenerOptions,
} from "./escrowEventListener.js";
import { EscrowStateProjector } from "./escrowStateProjector.js";

export interface EscrowListenerEnvConfig {
  enabled: boolean;
  contractAddressAllowList: string[];
  instanceId: string;
  tickIntervalMs: number;
  pageLimit?: number;
  finalityDepth?: number;
  freshnessSloSeconds?: number;
  horizonUrl?: string;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseEscrowListenerEnv(
  env: NodeJS.ProcessEnv = process.env,
): EscrowListenerEnvConfig {
  const enabled = env.ESCROW_LISTENER_ENABLED === "true";

  const contractAddressAllowList = (env.ESCROW_CONTRACT_ADDRESSES ?? "")
    .split(",")
    .map((addr) => addr.trim())
    .filter((addr) => addr.length > 0);

  const hostname = os.hostname().trim();
  const instanceId =
    env.ESCROW_LISTENER_INSTANCE_ID?.trim() ||
    hostname ||
    "chronopay-escrow-listener";

  const tickIntervalMs =
    parsePositiveInt(env.ESCROW_LISTENER_TICK_INTERVAL_MS) ?? 5_000;
  const pageLimit = parsePositiveInt(env.ESCROW_LISTENER_PAGE_LIMIT);
  const finalityDepth = parseNonNegativeInt(env.ESCROW_LISTENER_FINALITY_DEPTH);
  const freshnessSloSeconds = parsePositiveInt(
    env.ESCROW_LISTENER_FRESHNESS_SLO_SECONDS,
  );

  const horizonUrl =
    env.HORIZON_URL?.trim() ||
    env.HORIZON_URLS?.split(",")
      .map((u) => u.trim())
      .find((u) => u.length > 0);

  return {
    enabled,
    contractAddressAllowList,
    instanceId,
    tickIntervalMs,
    pageLimit,
    finalityDepth,
    freshnessSloSeconds,
    horizonUrl,
  };
}

/**
 * Default `IEscrowContractClient` backed by `HorizonEscrowReader` for latest
 * ledger discovery. `getEvents` returns an empty page until Soroban RPC event
 * indexing is wired (mirroring `HorizonEscrowReader.fetchEvents`).
 */
export class HorizonEscrowContractClient implements IEscrowContractClient {
  private readonly reader: HorizonEscrowReader | null;

  constructor(instanceId: string, horizonUrl?: string) {
    this.reader = horizonUrl
      ? new HorizonEscrowReader({ id: instanceId, horizonUrl })
      : null;
  }

  async getLatestLedger(): Promise<EscrowLedgerInfo> {
    if (!this.reader) {
      return {
        latestLedgerSeq: 0,
        latestCloseTime: new Date().toISOString(),
      };
    }
    return this.reader.getLatestLedger();
  }

  async getEvents(_args: GetEventsArgs): Promise<GetEventsResult> {
    const ledger = await this.getLatestLedger();
    return {
      events: [],
      latestLedgerSeq: ledger.latestLedgerSeq,
    };
  }
}

export interface StartEscrowListenerParams {
  env?: NodeJS.ProcessEnv;
  shouldStop?: () => boolean;
  contractClient?: IEscrowContractClient;
  cursorStore?: CursorStore;
  idempotencyStore?: IdempotencyStore;
  projector?: EscrowStateProjector;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface EscrowListenerHandle {
  instanceId: string;
  options: EscrowListenerOptions;
  loopPromise: Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Compose `EscrowListenerOptions` from env + optional overrides, and start
 * `runEscrowListener` if enabled and an address allowlist is configured.
 *
 * Returns `null` when disabled or when `ESCROW_CONTRACT_ADDRESSES` is empty.
 */
export function startEscrowListener(
  params: StartEscrowListenerParams = {},
): EscrowListenerHandle | null {
  const envConfig = parseEscrowListenerEnv(params.env);

  if (!envConfig.enabled) {
    logger.info("escrow-listener skipped: ESCROW_LISTENER_ENABLED is not true");
    return null;
  }

  if (envConfig.contractAddressAllowList.length === 0) {
    logger.warn(
      "escrow-listener skipped: ESCROW_CONTRACT_ADDRESSES allowlist is empty",
    );
    return null;
  }

  const cursorStore = params.cursorStore ?? new RedisCursorStore();
  const idempotencyStore = params.idempotencyStore ?? new RedisIdempotencyStore();
  const contractClient =
    params.contractClient ??
    new HorizonEscrowContractClient(envConfig.instanceId, envConfig.horizonUrl);
  const projector =
    params.projector ??
    new EscrowStateProjector(
      bookingIntentContainer.bookingIntentRepository,
      bookingIntentContainer.slotRepository,
      envConfig.contractAddressAllowList,
    );

  const options: EscrowListenerOptions = {
    instanceId: envConfig.instanceId,
    contractClient,
    cursorStore,
    idempotencyStore,
    projector,
    contractAddressAllowList: envConfig.contractAddressAllowList,
    pageLimit: envConfig.pageLimit,
    finalityDepth: envConfig.finalityDepth,
    freshnessSloSeconds: envConfig.freshnessSloSeconds,
    sleep: params.sleep,
    now: params.now,
  };

  let stopped = false;
  const shouldStop = () => stopped || (params.shouldStop?.() ?? false);

  const loopPromise = runEscrowListener({
    ...options,
    tickIntervalMs: envConfig.tickIntervalMs,
    shouldStop,
  }).catch((err: unknown) => {
    logger.error({ err, instanceId: envConfig.instanceId }, "escrow-listener exited unexpectedly");
  });

  return {
    instanceId: envConfig.instanceId,
    options,
    loopPromise,
    stop: async () => {
      stopped = true;
      await loopPromise;
    },
  };
}
