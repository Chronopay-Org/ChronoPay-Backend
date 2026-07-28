import { query as defaultQuery } from "../../db/pool.js";
import { QueryResult } from "pg";
import { RefundEntry, RefundEntryStatus, CreateRefundRequest } from "../../types/refund.js";

type QueryFn = (text: string, params?: unknown[]) => Promise<QueryResult>;

export class PgRefundRepository {
  constructor(private readonly dbQuery: QueryFn = defaultQuery) {}

  async create(request: CreateRefundRequest): Promise<RefundEntry> {
    const sql = `
      INSERT INTO refund_entries
        (payment_id, amount_cents, currency, reason, status, refunded_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const res = await this.dbQuery(sql, [
      request.paymentId,
      request.amountCents,
      request.currency ?? "USD",
      request.reason ?? null,
      "completed" as RefundEntryStatus,
      request.refundedBy ?? null,
    ]);
    return this.mapRow(res.rows[0]);
  }

  async findByPaymentId(paymentId: string): Promise<RefundEntry[]> {
    const res = await this.dbQuery(
      `SELECT * FROM refund_entries WHERE payment_id = $1 ORDER BY created_at ASC`,
      [paymentId],
    );
    return res.rows.map((row) => this.mapRow(row));
  }

  async sumRefundedCents(paymentId: string): Promise<number> {
    const res = await this.dbQuery(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM refund_entries WHERE payment_id = $1`,
      [paymentId],
    );
    return Number(res.rows[0].total);
  }

  async findById(id: string): Promise<RefundEntry | null> {
    const res = await this.dbQuery(
      `SELECT * FROM refund_entries WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? this.mapRow(res.rows[0]) : null;
  }

  private mapRow(row: Record<string, unknown>): RefundEntry {
    return {
      id: row.id as string,
      paymentId: row.payment_id as string,
      amountCents: row.amount_cents as number,
      currency: (row.currency as string) ?? "USD",
      reason: (row.reason as string) ?? undefined,
      status: row.status as RefundEntryStatus,
      refundedBy: (row.refunded_by as string) ?? undefined,
      createdAt: Math.floor(new Date(row.created_at as string).getTime() / 1000),
    };
  }
}

export const defaultRefundRepository = new PgRefundRepository();