import { query } from "../db/pool.js";

const DEFAULT_RETENTION_DAYS = 30;

export class WebhookIdempotencyStore {
  /**
   * Tries to save an idempotency key if it does not already exist.
   * Returns true if saved, false if it already exists.
   */
  static async saveKey(
    tenantId: string,
    idempotencyKey: string,
    responseBody: any,
    retentionDays: number = DEFAULT_RETENTION_DAYS
  ): Promise<boolean> {
    try {
      await query(
        `INSERT INTO webhook_idempotency_keys (tenant_id, idempotency_key, response_body, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '1 day' * $4)`,
        [tenantId, idempotencyKey, JSON.stringify(responseBody), retentionDays]
      );
      return true;
    } catch (error: any) {
      if (error.code === '23505') { // unique_violation
        return false;
      }
      throw error;
    }
  }

  static async getExistingResponse(tenantId: string, idempotencyKey: string): Promise<any | null> {
    const res = await query(
      `SELECT response_body FROM webhook_idempotency_keys
       WHERE tenant_id = $1 AND idempotency_key = $2 AND expires_at > NOW()`,
      [tenantId, idempotencyKey]
    );
    if (res.rowCount && res.rowCount > 0) {
      return res.rows[0].response_body;
    }
    return null;
  }

  static async sweep(): Promise<number> {
    const res = await query(`DELETE FROM webhook_idempotency_keys WHERE expires_at <= NOW()`);
    return res.rowCount ?? 0;
  }

  static async inspect(tenantId: string, idempotencyKey: string): Promise<any | null> {
    const res = await query(
      `SELECT * FROM webhook_idempotency_keys WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey]
    );
    if (res.rowCount && res.rowCount > 0) {
      return res.rows[0];
    }
    return null;
  }
}
