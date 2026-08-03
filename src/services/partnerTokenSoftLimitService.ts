/**
 * partnerTokenSoftLimitService.ts
 *
 * Soft-limit warning webhooks for partner token quotas.
 *
 * Partners configure a soft-limit threshold (fraction of hard cutoff) and a
 * webhook URL. When usage crosses that threshold, a warning is enqueued into
 * a delivery ledger with a 15-minute dedupe key, then delivered with
 * at-least-once semantics (pending/failed entries are retried until acked).
 */

import { query } from "../db/pool.js";
import { defaultAuditLogger } from "./auditLogger.js";
import { logger } from "../utils/logger.js";

export interface PartnerSoftLimitConfig {
  partnerId: string;
  softLimit: number;
  webhookUrl: string;
}

export type DeliveryStatus = "pending" | "delivered" | "acked" | "failed";

export interface DeliveryLedgerEntry {
  id: string;
  partnerId: string;
  tokenUsage: number;
  softLimit: number;
  thresholdPct: number;
  webhookUrl: string;
  status: DeliveryStatus;
  attemptCount: number;
  lastError: string | null;
  ackedAt: Date | null;
  dedupeKey: string;
  createdAt: Date;
}

export const DEFAULT_SOFT_LIMIT = 0.8;
export const MAX_DELIVERY_ATTEMPTS = 8;
const DEDUPE_WINDOW_MS = 15 * 60 * 1000;

/** Optional injectable query fn + fetch for tests. */
export type SoftLimitDeps = {
  queryFn?: typeof query;
  fetchFn?: typeof fetch;
  nowMs?: () => number;
};

let deps: SoftLimitDeps = {};

export function _setSoftLimitDeps(next: SoftLimitDeps): void {
  deps = next;
}

export function _resetSoftLimitDeps(): void {
  deps = {};
}

function q(): typeof query {
  return deps.queryFn ?? query;
}

function fetchImpl(): typeof fetch {
  return deps.fetchFn ?? fetch;
}

function now(): number {
  return (deps.nowMs ?? Date.now)();
}

function assertHttpsWebhookUrl(webhookUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    throw new Error("webhookUrl must be a valid URL");
  }
  if (parsed.protocol !== "https:" && process.env.NODE_ENV !== "test") {
    throw new Error("webhookUrl must use https");
  }
}

export class PartnerTokenSoftLimitService {
  /**
   * Configures the soft-limit threshold for a partner.
   * softLimit is a fraction of the hard cutoff in (0, 1].
   */
  static async upsertConfig(
    partnerId: string,
    webhookUrl: string,
    softLimit: number = DEFAULT_SOFT_LIMIT,
  ): Promise<void> {
    if (softLimit <= 0 || softLimit > 1) {
      throw new Error("softLimit must be in the range (0, 1]");
    }
    if (!webhookUrl) {
      throw new Error("webhookUrl is required");
    }
    assertHttpsWebhookUrl(webhookUrl);

    await q()(
      `INSERT INTO partner_token_soft_limit_config (partner_id, soft_limit, webhook_url, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (partner_id)
       DO UPDATE SET soft_limit = EXCLUDED.soft_limit,
                     webhook_url = EXCLUDED.webhook_url,
                     updated_at = NOW()`,
      [partnerId, softLimit, webhookUrl],
    );
  }

  static async getConfig(partnerId: string): Promise<PartnerSoftLimitConfig | null> {
    const res = await q()(
      `SELECT partner_id, soft_limit, webhook_url
       FROM partner_token_soft_limit_config WHERE partner_id = $1`,
      [partnerId],
    );
    if (res.rowCount && res.rowCount > 0) {
      const row = res.rows[0];
      return {
        partnerId: row.partner_id,
        softLimit: Number(row.soft_limit),
        webhookUrl: row.webhook_url,
      };
    }
    return null;
  }

  static computeThreshold(
    usage: number,
    hardCutoff: number,
    softLimit: number,
  ): { breached: boolean; thresholdPct: number } {
    if (hardCutoff <= 0) {
      return { breached: false, thresholdPct: 0 };
    }
    const thresholdPct = usage / hardCutoff;
    return {
      breached: thresholdPct >= softLimit,
      thresholdPct,
    };
  }

  /**
   * Dedupe key: partner + rounded percent + 15-minute window.
   * Multiple checks in the same window share one ledger row.
   */
  static dedupeKey(partnerId: string, thresholdPct: number, nowMs: number = now()): string {
    const windowStart = Math.floor(nowMs / DEDUPE_WINDOW_MS);
    const roundedPct = Math.round(thresholdPct * 100);
    return `${partnerId}:${roundedPct}:${windowStart}`;
  }

  static async enqueueWarning(
    partnerId: string,
    tokenUsage: number,
    thresholdPct: number,
    webhookUrl: string,
    softLimit: number,
  ): Promise<DeliveryLedgerEntry | null> {
    const key = this.dedupeKey(partnerId, thresholdPct);

    try {
      const res = await q()(
        `INSERT INTO partner_token_delivery_ledger
         (partner_id, token_usage, soft_limit, threshold_pct, webhook_url, status, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6)
         RETURNING id, partner_id, token_usage, soft_limit, threshold_pct, webhook_url,
                   status, attempt_count, last_error, acked_at, dedupe_key, created_at`,
        [partnerId, tokenUsage, softLimit, thresholdPct, webhookUrl, key],
      );
      return this.rowToEntry(res.rows[0]);
    } catch (error: any) {
      if (error?.code === "23505") {
        return null;
      }
      throw error;
    }
  }

  /**
   * Entries eligible for retry: pending or failed, under max attempts.
   * At-least-once: failed deliveries stay retryable until acked or exhausted.
   */
  static async getRetryableDeliveries(
    maxAttempts: number = MAX_DELIVERY_ATTEMPTS,
  ): Promise<DeliveryLedgerEntry[]> {
    const res = await q()(
      `SELECT id, partner_id, token_usage, soft_limit, threshold_pct, webhook_url,
              status, attempt_count, last_error, acked_at, dedupe_key, created_at
       FROM partner_token_delivery_ledger
       WHERE status IN ('pending', 'failed')
         AND attempt_count < $1
       ORDER BY created_at ASC`,
      [maxAttempts],
    );
    return res.rows.map((row: any) => this.rowToEntry(row));
  }

  /** @deprecated Prefer getRetryableDeliveries for at-least-once retries. */
  static async getPendingDeliveries(): Promise<DeliveryLedgerEntry[]> {
    return this.getRetryableDeliveries();
  }

  static async recordAttempt(
    entryId: string,
    ok: boolean,
    errorMessage?: string,
  ): Promise<void> {
    if (ok) {
      await q()(
        `UPDATE partner_token_delivery_ledger
         SET status = 'acked',
             acked_at = NOW(),
             attempt_count = attempt_count + 1,
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $1 AND status IN ('pending', 'failed', 'delivered')`,
        [entryId],
      );
      return;
    }

    await q()(
      `UPDATE partner_token_delivery_ledger
       SET status = 'failed',
           attempt_count = attempt_count + 1,
           last_error = $2,
           updated_at = NOW()
       WHERE id = $1 AND status IN ('pending', 'failed', 'delivered')`,
      [entryId, errorMessage ?? "delivery failed"],
    );
  }

  /**
   * Main entrypoint: if soft-limit breached, enqueue a deduped warning.
   */
  static async checkAndWarn(
    partnerId: string,
    usage: number,
    hardCutoff: number,
  ): Promise<DeliveryLedgerEntry | null> {
    const config = await this.getConfig(partnerId);
    if (!config) {
      return null;
    }

    const { breached, thresholdPct } = this.computeThreshold(
      usage,
      hardCutoff,
      config.softLimit,
    );
    if (!breached) {
      return null;
    }

    const entry = await this.enqueueWarning(
      partnerId,
      usage,
      thresholdPct,
      config.webhookUrl,
      config.softLimit,
    );

    if (entry) {
      await defaultAuditLogger.log({
        action: "partner_token.soft_limit_breach",
        status: "warning",
        resource: `partner:${partnerId}`,
        metadata: { usage, thresholdPct, softLimit: config.softLimit },
      });
    }

    return entry;
  }

  private static rowToEntry(row: any): DeliveryLedgerEntry {
    return {
      id: row.id,
      partnerId: row.partner_id,
      tokenUsage: Number(row.token_usage),
      softLimit: Number(row.soft_limit),
      thresholdPct: Number(row.threshold_pct),
      webhookUrl: row.webhook_url,
      status: row.status,
      attemptCount: Number(row.attempt_count ?? 0),
      lastError: row.last_error ?? null,
      ackedAt: row.acked_at ?? null,
      dedupeKey: row.dedupe_key,
      createdAt: row.created_at,
    };
  }
}

/**
 * Deliver one warning. Stays retryable on failure (at-least-once).
 * Only marks acked after a successful 2xx response.
 */
export async function deliverWarningWebhook(
  entry: DeliveryLedgerEntry,
  signal?: AbortSignal,
): Promise<boolean> {
  const payload = {
    event: "token_quota_warning",
    partner_id: entry.partnerId,
    token_usage: entry.tokenUsage,
    soft_limit: entry.softLimit,
    threshold_percent: Math.round(entry.thresholdPct * 100),
    message: `Token usage has reached ${Math.round(entry.thresholdPct * 100)}% of the hard cutoff.`,
    timestamp: new Date().toISOString(),
  };

  try {
    const response = await fetchImpl()(entry.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });

    if (response.ok) {
      await PartnerTokenSoftLimitService.recordAttempt(entry.id, true);
      return true;
    }

    await PartnerTokenSoftLimitService.recordAttempt(
      entry.id,
      false,
      `HTTP ${response.status}`,
    );
    return false;
  } catch (err: any) {
    await PartnerTokenSoftLimitService.recordAttempt(
      entry.id,
      false,
      err?.message ?? "network error",
    );
    return false;
  }
}

export async function processPendingDeliveries(): Promise<{
  delivered: number;
  failed: number;
}> {
  const pending = await PartnerTokenSoftLimitService.getRetryableDeliveries();
  let delivered = 0;
  let failed = 0;

  for (const entry of pending) {
    const ok = await deliverWarningWebhook(entry);
    if (ok) {
      delivered++;
    } else {
      failed++;
    }
  }

  return { delivered, failed };
}

/**
 * Best-effort hook for the quota consume path.
 * Never throws into the request path — failures are logged only.
 */
export async function maybeEnqueueSoftLimitWarning(
  partnerId: string,
  usage: number,
  hardCutoff: number,
): Promise<void> {
  try {
    const entry = await PartnerTokenSoftLimitService.checkAndWarn(
      partnerId,
      usage,
      hardCutoff,
    );
    if (entry) {
      // Fire-and-forget first delivery attempt; cron can retry.
      void deliverWarningWebhook(entry).catch((err) => {
        logger.warn(
          { err, partnerId, entryId: entry.id },
          "partner soft-limit webhook delivery failed",
        );
      });
    }
  } catch (err) {
    logger.warn({ err, partnerId }, "partner soft-limit check failed");
  }
}
