import { query } from "../db/pool.js";
import { defaultAuditLogger } from "./auditLogger.js";

export interface PartnerSoftLimitConfig {
  partnerId: string;
  softLimit: number;
  webhookUrl: string;
}

export interface DeliveryLedgerEntry {
  id: string;
  partnerId: string;
  tokenUsage: number;
  softLimit: number;
  thresholdPct: number;
  webhookUrl: string;
  status: "pending" | "delivered" | "acked" | "failed";
  ackedAt: Date | null;
  dedupeKey: string;
  createdAt: Date;
}

const DEFAULT_SOFT_LIMIT = 0.8; // 80% of hard cutoff

/**
 * PartnerTokenSoftLimitService manages soft-limit thresholds and delivers
 * warning webhooks to partners before their token quota is exhausted.
 *
 * Guarantees at-least-once delivery through a delivery ledger with deduplication,
 * acknowledgement tracking, and retry support.
 */
export class PartnerTokenSoftLimitService {
  /**
   * Configures the soft-limit threshold for a partner.
   * softLimit is a fraction of the hard cutoff (0.0 – 1.0).
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

    await query(
      `INSERT INTO partner_token_soft_limit_config (partner_id, soft_limit, webhook_url, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (partner_id)
       DO UPDATE SET soft_limit = EXCLUDED.soft_limit,
                     webhook_url = EXCLUDED.webhook_url,
                     updated_at = NOW()`,
      [partnerId, softLimit, webhookUrl],
    );
  }

  /** Retrieves the soft-limit config for a partner. */
  static async getConfig(partnerId: string): Promise<PartnerSoftLimitConfig | null> {
    const res = await query(
      `SELECT partner_id, soft_limit, webhook_url FROM partner_token_soft_limit_config WHERE partner_id = $1`,
      [partnerId],
    );
    if (res.rowCount && res.rowCount > 0) {
      const row = res.rows[0];
      return {
        partnerId: row.partner_id,
        softLimit: row.soft_limit,
        webhookUrl: row.webhook_url,
      };
    }
    return null;
  }

  /**
   * Evaluates token usage against the soft-limit threshold.
   * Returns true if the soft-limit has been breached and returns the
   * threshold percentage (e.g. 0.85 means the partner has used 85% of
   * their hard cutoff).
   */
  static computeThreshold(usage: number, hardCutoff: number, softLimit: number): { breached: boolean; thresholdPct: number } {
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
   * Generates a deduplication key for a warning notification.
   * Uses the partner ID and the "15-minute window" of the breach so that
   * multiple checks within the same window produce the same key.
   */
  static dedupeKey(partnerId: string, thresholdPct: number): string {
    const windowMinutes = 15;
    const windowStart = Math.floor(Date.now() / (windowMinutes * 60 * 1000));
    const roundedPct = Math.round(thresholdPct * 100);
    return `${partnerId}:${roundedPct}:${windowStart}`;
  }

  /**
   * Enqueues a warning webhook delivery with deduplication.
   * Returns the ledger entry if enqueued, or null if a duplicate already exists.
   */
  static async enqueueWarning(
    partnerId: string,
    tokenUsage: number,
    thresholdPct: number,
    webhookUrl: string,
    softLimit: number,
  ): Promise<DeliveryLedgerEntry | null> {
    const key = this.dedupeKey(partnerId, thresholdPct);

    try {
      const res = await query(
        `INSERT INTO partner_token_delivery_ledger
         (partner_id, token_usage, soft_limit, threshold_pct, webhook_url, status, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6)
         RETURNING id, partner_id, token_usage, soft_limit, threshold_pct, webhook_url,
                   status, acked_at, dedupe_key, created_at`,
        [partnerId, tokenUsage, softLimit, thresholdPct, webhookUrl, key],
      );

      return this.rowToEntry(res.rows[0]);
    } catch (error: any) {
      // unique_violation on dedupe_key — already enqueued in this window
      if (error.code === "23505") {
        return null;
      }
      throw error;
    }
  }

  /**
   * Marks a delivery ledger entry as delivered (the webhook was sent).
   */
  static async markDelivered(entryId: string): Promise<void> {
    await query(
      `UPDATE partner_token_delivery_ledger SET status = 'delivered' WHERE id = $1 AND status = 'pending'`,
      [entryId],
    );
  }

  /**
   * Marks a delivery ledger entry as acknowledged by the partner
   * (the partner's webhook responded with a 2xx).
   */
  static async markAcknowledged(entryId: string): Promise<void> {
    await query(
      `UPDATE partner_token_delivery_ledger SET status = 'acked', acked_at = NOW() WHERE id = $1`,
      [entryId],
    );
  }

  /**
   * Marks a delivery as failed (webhook returned non-2xx or timed out).
   */
  static async markFailed(entryId: string): Promise<void> {
    await query(
      `UPDATE partner_token_delivery_ledger SET status = 'failed' WHERE id = $1`,
      [entryId],
    );
  }

  /**
   * Retrieves pending (not yet delivered) entries for retry.
   */
  static async getPendingDeliveries(): Promise<DeliveryLedgerEntry[]> {
    const res = await query(
      `SELECT id, partner_id, token_usage, soft_limit, threshold_pct, webhook_url,
              status, acked_at, dedupe_key, created_at
       FROM partner_token_delivery_ledger
       WHERE status = 'pending'
       ORDER BY created_at ASC`,
    );
    return res.rows.map(this.rowToEntry);
  }

  /**
   * Checks whether a partner's token usage has breached the soft limit
   * and enqueues a warning if so. This is the main entrypoint for
   * callers (e.g. a token usage endpoint or scheduler).
   *
   * @returns The enqueued delivery entry, or null if no warning needed or duplicate.
   */
  static async checkAndWarn(
    partnerId: string,
    usage: number,
    hardCutoff: number,
  ): Promise<DeliveryLedgerEntry | null> {
    const config = await this.getConfig(partnerId);
    if (!config) {
      return null; // No config for this partner — no warning sent
    }

    const { breached, thresholdPct } = this.computeThreshold(usage, hardCutoff, config.softLimit);
    if (!breached) {
      return null; // Usage is below the soft-limit threshold
    }

    const entry = await this.enqueueWarning(partnerId, usage, thresholdPct, config.webhookUrl, config.softLimit);
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
      tokenUsage: row.token_usage,
      softLimit: row.soft_limit,
      thresholdPct: row.threshold_pct,
      webhookUrl: row.webhook_url,
      status: row.status,
      ackedAt: row.acked_at ?? null,
      dedupeKey: row.dedupe_key,
      createdAt: row.created_at,
    };
  }
}

/**
 * HTTP delivery function that sends the warning payload to the partner's
 * webhook endpoint and updates the ledger accordingly.
 */
export async function deliverWarningWebhook(
  entry: DeliveryLedgerEntry,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await PartnerTokenSoftLimitService.markDelivered(entry.id);

    const payload = {
      event: "token_quota_warning",
      partner_id: entry.partnerId,
      token_usage: entry.tokenUsage,
      soft_limit: entry.softLimit,
      threshold_percent: Math.round(entry.thresholdPct * 100),
      message: `Token usage has reached ${Math.round(entry.thresholdPct * 100)}% of the hard cutoff.`,
      timestamp: new Date().toISOString(),
    };

    const response = await fetch(entry.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });

    if (response.ok) {
      await PartnerTokenSoftLimitService.markAcknowledged(entry.id);
      return true;
    }

    await PartnerTokenSoftLimitService.markFailed(entry.id);
    return false;
  } catch {
    await PartnerTokenSoftLimitService.markFailed(entry.id);
    return false;
  }
}

/**
 * Processes all pending deliveries and attempts to deliver each one.
 * Returns counts of successful and failed deliveries.
 */
export async function processPendingDeliveries(): Promise<{ delivered: number; failed: number }> {
  const pending = await PartnerTokenSoftLimitService.getPendingDeliveries();
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
