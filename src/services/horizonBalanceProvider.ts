import type { HorizonHostManager } from "../clients/horizon-host-manager.js";
import { treasuryPollFailures } from "../metrics.js";
import { logger } from "../utils/logger.js";
import type { BalanceProvider, TreasuryBalanceEntry } from "./treasuryBalancePoller.js";

const STROOPS_PER_UNIT = 10_000_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type HorizonHostManagerLike = Pick<
  HorizonHostManager,
  "getHealthyHost" | "recordSuccess" | "recordError"
>;

export interface HorizonBalanceRecord {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
}

export interface HorizonAccountBalancesResponse {
  id?: string;
  balances?: HorizonBalanceRecord[];
}

export interface HorizonBalanceProviderOptions {
  /** Custom fetch implementation (useful for testing). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds. Default 10 000. */
  timeoutMs?: number;
  /** Optional callback invoked when a single account poll fails. */
  onAccountError?: (account: string, error: unknown) => void;
}

/**
 * Convert a Horizon decimal balance string (up to 7 decimal places) into
 * integer stroops without floating-point precision loss.
 */
export function decimalBalanceToStroops(rawBalance: string): number {
  const trimmed = rawBalance.trim();
  const match = trimmed.match(/^(\d+)(?:\.(\d{1,7}))?$/);
  if (!match) {
    throw new Error(`Invalid Horizon balance string: "${rawBalance}"`);
  }
  const whole = Number.parseInt(match[1], 10);
  const fractional = (match[2] ?? "").padEnd(7, "0");
  return whole * STROOPS_PER_UNIT + Number.parseInt(fractional, 10);
}

/**
 * Resolve a Horizon balance record's asset identifier.
 * Native XLM returns `"XLM"`; credit assets return their `asset_code`.
 * Non-standard entries (e.g. `liquidity_pool_shares`) return `undefined`.
 */
function resolveAssetCode(record: HorizonBalanceRecord): string | undefined {
  if (record.asset_type === "native") {
    return "XLM";
  }
  if (typeof record.asset_code === "string" && record.asset_code.trim().length > 0) {
    return record.asset_code.trim();
  }
  return undefined;
}

/**
 * Create a {@link BalanceProvider} that queries Stellar Horizon for each
 * configured treasury account and returns balances in stroops.
 *
 * Per-account failures are isolated: if one account's Horizon request fails,
 * `treasury_poll_failures_total` is incremented for that account, the host
 * manager records the error, and remaining accounts are still polled.
 */
export function createHorizonBalanceProvider(
  accounts: readonly string[],
  hostManager: HorizonHostManagerLike,
  options: HorizonBalanceProviderOptions = {},
): BalanceProvider {
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return async (): Promise<TreasuryBalanceEntry[]> => {
    const entries: TreasuryBalanceEntry[] = [];

    for (const account of accounts) {
      let host: string | undefined;
      try {
        host = await hostManager.getHealthyHost();
        const url = `${host.replace(/\/$/, "")}/accounts/${encodeURIComponent(account)}`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let response: Response;
        try {
          response = await fetchFn(url, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (!response.ok) {
          const httpError = Object.assign(
            new Error(`Horizon returned HTTP ${response.status} for account ${account}`),
            { statusCode: response.status },
          );
          throw httpError;
        }

        const payload = (await response.json()) as HorizonAccountBalancesResponse;
        hostManager.recordSuccess(host);

        const balances = Array.isArray(payload.balances) ? payload.balances : [];
        for (const record of balances) {
          const asset = resolveAssetCode(record);
          if (!asset) continue;

          const balance = decimalBalanceToStroops(record.balance);
          entries.push({ account, asset, balance });
        }
      } catch (error) {
        if (host) {
          hostManager.recordError(host, error);
        }
        treasuryPollFailures.labels("unknown", account).inc();
        logger.warn(
          { account, host, err: error },
          "treasury-balance-poller: failed to fetch Horizon account balances",
        );
        options.onAccountError?.(account, error);
      }
    }

    return entries;
  };
}
