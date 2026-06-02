import { CheckoutSession, CheckoutSessionStatus } from "../../types/checkout.js";
import { query as defaultQuery } from "../../db/pool.js";
import { QueryResult } from "pg";

type QueryFn = (text: string, params?: unknown[]) => Promise<QueryResult>;

/**
 * PostgreSQL repository for checkout sessions.
 *
 * All timestamps are stored as TIMESTAMPTZ and converted to/from Unix seconds
 * to match the CheckoutSession domain type.
 *
 * Expiry is determined by comparing NOW() against the `expires_at` column —
 * no in-process timer is required.
 */
export class PgCheckoutSessionRepository {
  constructor(private readonly dbQuery: QueryFn = defaultQuery) {}

  async create(session: CheckoutSession): Promise<CheckoutSession> {
    const sql = `
      INSERT INTO checkout_sessions
        (id, payment, customer, status, metadata, success_url, cancel_url,
         payment_token, created_at, updated_at, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
              to_timestamp($9), to_timestamp($10), to_timestamp($11))
      RETURNING *
    `;
    const res = await this.dbQuery(sql, [
      session.id,
      JSON.stringify(session.payment),
      JSON.stringify(session.customer),
      session.status,
      session.metadata ? JSON.stringify(session.metadata) : null,
      session.successUrl ?? null,
      session.cancelUrl ?? null,
      session.paymentToken ?? null,
      session.createdAt,
      session.updatedAt,
      session.expiresAt,
    ]);
    return this.mapRow(res.rows[0]);
  }

  /**
   * Finds a session by ID. Returns null if not found.
   * Does NOT filter by expiry — callers decide how to handle expired sessions.
   */
  async findById(id: string): Promise<CheckoutSession | null> {
    const res = await this.dbQuery(
      `SELECT * FROM checkout_sessions WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? this.mapRow(res.rows[0]) : null;
  }

  /**
   * Updates status, updatedAt, and optionally paymentToken / metadata.
   */
  async updateSession(
    id: string,
    fields: {
      status: CheckoutSessionStatus;
      updatedAt: number;
      paymentToken?: string;
      metadata?: Record<string, string | number | boolean>;
    },
  ): Promise<CheckoutSession> {
    const sql = `
      UPDATE checkout_sessions
      SET status        = $2,
          updated_at    = to_timestamp($3),
          payment_token = COALESCE($4, payment_token),
          metadata      = COALESCE($5::jsonb, metadata)
      WHERE id = $1
      RETURNING *
    `;
    const res = await this.dbQuery(sql, [
      id,
      fields.status,
      fields.updatedAt,
      fields.paymentToken ?? null,
      fields.metadata ? JSON.stringify(fields.metadata) : null,
    ]);
    return this.mapRow(res.rows[0]);
  }

  private mapRow(row: Record<string, unknown>): CheckoutSession {
    return {
      id: row.id as string,
      payment: row.payment as CheckoutSession["payment"],
      customer: row.customer as CheckoutSession["customer"],
      status: row.status as CheckoutSessionStatus,
      metadata: (row.metadata as CheckoutSession["metadata"]) ?? undefined,
      successUrl: (row.success_url as string) ?? undefined,
      cancelUrl: (row.cancel_url as string) ?? undefined,
      paymentToken: (row.payment_token as string) ?? undefined,
      createdAt: Math.floor(new Date(row.created_at as string).getTime() / 1000),
      updatedAt: Math.floor(new Date(row.updated_at as string).getTime() / 1000),
      expiresAt: Math.floor(new Date(row.expires_at as string).getTime() / 1000),
    };
  }
}
