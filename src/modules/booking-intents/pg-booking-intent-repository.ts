import { query } from "../../db/pool.js";
import { ConflictError, NotFoundError } from "../../errors/AppError.js";
import {
  BookingIntentRecord,
  BookingIntentRepository,
  BookingIntentStatus,
  BookingType,
} from "./booking-intent-repository.js";

/** SQL fragment filtering for active hold statuses, matching the partial
 * unique index from migration 019_add_active_booking_intent_unique_idx.ts. */
const ACTIVE_STATUS_FILTER = `status IN ('pending', 'hold_placed')`;

/**
 * PostgreSQL implementation of the booking-intent repository.
 *
 * This repository handles persistence for booking intents using the 'booking_intents' table.
 * It maps between the domain BookingIntentRecord and the database schema.
 */
export class PgBookingIntentRepository implements BookingIntentRepository {
  constructor(private readonly dbQuery = query) {}

  async create(intent: Omit<BookingIntentRecord, "id">): Promise<BookingIntentRecord> {
    const sql = `
      INSERT INTO booking_intents (
        slot_id,
        professional_id,
        customer_id,
        start_time,
        end_time,
        status,
        note,
        created_at,
        updated_at,
        booking_type,
        hold_until_ms,
        hold_placed_at,
        refunded_at,
        refund_metadata,
        pricing_snapshot,
        cancellation_policy_snapshot,
        hold_fee_policy_snapshot
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *
    `;

    const values = [
      intent.slotId,
      intent.professional, // maps to professional_id in DB
      intent.customerId,
      new Date(intent.startTime),
      new Date(intent.endTime),
      intent.status,
      intent.note || null,
      new Date(intent.createdAt),
      intent.bookingType ?? "standard",
      intent.holdUntilMs ?? null,
      intent.holdPlacedAt ? new Date(intent.holdPlacedAt) : null,
      intent.refundedAt ? new Date(intent.refundedAt) : null,
      intent.refundMetadata ?? null,
      intent.pricingSnapshot ?? null,
      intent.cancellationPolicySnapshot ?? null,
      intent.holdFeePolicySnapshot ?? null,
    ];

    try {
      const res = await this.dbQuery(sql, values);
      return this.mapRowToRecord(res.rows[0]);
    } catch (err: any) {
      // Partial unique index violation — another active intent exists for this slot.
      if (err?.code === "23505") {
        throw new ConflictError(
          "An active booking intent already exists for this slot.",
        );
      }
      throw err;
    }
  }

  async findBySlotId(slotId: string): Promise<BookingIntentRecord | undefined> {
    const sql = `SELECT * FROM booking_intents WHERE slot_id = $1 AND ${ACTIVE_STATUS_FILTER} LIMIT 1`;
    const res = await this.dbQuery(sql, [slotId]);
    return res.rows[0] ? this.mapRowToRecord(res.rows[0]) : undefined;
  }

  async findById(id: string): Promise<BookingIntentRecord | undefined> {
    const sql = `SELECT * FROM booking_intents WHERE id = $1 LIMIT 1`;
    const res = await this.dbQuery(sql, [id]);
    return res.rows[0] ? this.mapRowToRecord(res.rows[0]) : undefined;
  }

  async findBySlotIdAndCustomer(slotId: string, customerId: string): Promise<BookingIntentRecord | undefined> {
    const sql = `SELECT * FROM booking_intents WHERE slot_id = $1 AND customer_id = $2 AND ${ACTIVE_STATUS_FILTER} LIMIT 1`;
    const res = await this.dbQuery(sql, [slotId, customerId]);
    return res.rows[0] ? this.mapRowToRecord(res.rows[0]) : undefined;
  }

  async updateTokenInfo(id: string, tokenAsset: string, mintTxHash: string): Promise<void> {
    const sql = `
      UPDATE booking_intents
      SET token_asset = $2, mint_tx_hash = $3, updated_at = NOW()
      WHERE id = $1
    `;
    await this.dbQuery(sql, [id, tokenAsset, mintTxHash]);
  }

  async updateStatus(id: string, status: BookingIntentStatus): Promise<BookingIntentRecord> {
    const sql = `
      UPDATE booking_intents
      SET status = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
    const res = await this.dbQuery(sql, [id, status]);
    if (!res.rows[0]) {
      throw new NotFoundError(`BookingIntent with id "${id}" not found`);
    }
    return this.mapRowToRecord(res.rows[0]);
  }

  async update(id: string, updates: Partial<Omit<BookingIntentRecord, "id">>): Promise<BookingIntentRecord> {
    const allowedColumns = this.buildUpdateColumnMap(updates);
    const keys = Object.keys(allowedColumns);

    if (keys.length === 0) {
      // No updatable columns provided — return the existing record unchanged.
      const existing = await this.findById(id);
      if (!existing) {
        throw new NotFoundError(`BookingIntent with id "${id}" not found`);
      }
      return existing;
    }

    const setClauses = keys.map((col, i) => `${col} = $${i + 2}`);
    const values = keys.map((k) => allowedColumns[k]);

    const sql = `
      UPDATE booking_intents
      SET ${setClauses.join(", ")}, updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;

    const res = await this.dbQuery(sql, [id, ...values]);
    if (!res.rows[0]) {
      throw new NotFoundError(`BookingIntent with id "${id}" not found`);
    }
    return this.mapRowToRecord(res.rows[0]);
  }

  async listByCustomer(customerId: string): Promise<BookingIntentRecord[]> {
    const sql = `SELECT * FROM booking_intents WHERE customer_id = $1 ORDER BY created_at DESC`;
    const res = await this.dbQuery(sql, [customerId]);
    return res.rows.map((row: any) => this.mapRowToRecord(row));
  }

  async listAll(): Promise<BookingIntentRecord[]> {
    const sql = `SELECT * FROM booking_intents ORDER BY created_at DESC`;
    const res = await this.dbQuery(sql);
    return res.rows.map((row: any) => this.mapRowToRecord(row));
  }

  async findExpiredHolds(nowMs: number): Promise<BookingIntentRecord[]> {
    const sql = `
      SELECT * FROM booking_intents
      WHERE booking_type = 'refundable_hold'
        AND status = 'hold_placed'
        AND hold_until_ms IS NOT NULL
        AND hold_until_ms <= $1
    `;
    const res = await this.dbQuery(sql, [nowMs]);
    return res.rows.map((row: any) => this.mapRowToRecord(row));
  }

  /**
   * Builds a mapping of database column name → bound value for the updatable
   * fields of BookingIntentRecord, converting domain field names to their
   * database column counterparts and serialising complex objects to JSON.
   */
  private buildUpdateColumnMap(updates: Partial<Omit<BookingIntentRecord, "id">>): Record<string, unknown> {
    const cols: Record<string, unknown> = {};

    if (updates.status !== undefined) cols.status = updates.status;
    if (updates.note !== undefined) cols.note = updates.note;
    if (updates.tokenAsset !== undefined) cols.token_asset = updates.tokenAsset;
    if (updates.mintTxHash !== undefined) cols.mint_tx_hash = updates.mintTxHash;
    if (updates.bookingType !== undefined) cols.booking_type = updates.bookingType;
    if (updates.holdUntilMs !== undefined) cols.hold_until_ms = updates.holdUntilMs;
    if (updates.holdPlacedAt !== undefined) cols.hold_placed_at = updates.holdPlacedAt ? new Date(updates.holdPlacedAt) : null;
    if (updates.refundedAt !== undefined) cols.refunded_at = updates.refundedAt ? new Date(updates.refundedAt) : null;
    if (updates.refundMetadata !== undefined) cols.refund_metadata = updates.refundMetadata;
    if (updates.pricingSnapshot !== undefined) cols.pricing_snapshot = updates.pricingSnapshot;
    if (updates.cancellationPolicySnapshot !== undefined) cols.cancellation_policy_snapshot = updates.cancellationPolicySnapshot;
    if (updates.holdFeePolicySnapshot !== undefined) cols.hold_fee_policy_snapshot = updates.holdFeePolicySnapshot;

    return cols;
  }

  /**
   * Maps a database row to a BookingIntentRecord domain object.
   * Converts database TIMESTAMPTZ to milliseconds for the domain record.
   */
  private mapRowToRecord(row: any): BookingIntentRecord {
    return {
      id: row.id,
      slotId: row.slot_id,
      professional: row.professional_id,
      customerId: row.customer_id,
      startTime: new Date(row.start_time).getTime(),
      endTime: new Date(row.end_time).getTime(),
      status: row.status as BookingIntentStatus,
      note: row.note || undefined,
      tokenAsset: row.token_asset || undefined,
      mintTxHash: row.mint_tx_hash || undefined,
      createdAt: new Date(row.created_at).toISOString(),
      bookingType: (row.booking_type as BookingType) || undefined,
      holdUntilMs: row.hold_until_ms !== null && row.hold_until_ms !== undefined ? Number(row.hold_until_ms) : undefined,
      holdPlacedAt: row.hold_placed_at ? new Date(row.hold_placed_at).toISOString() : undefined,
      refundedAt: row.refunded_at ? new Date(row.refunded_at).toISOString() : undefined,
      refundMetadata: row.refund_metadata ?? undefined,
      pricingSnapshot: row.pricing_snapshot ?? undefined,
      cancellationPolicySnapshot: row.cancellation_policy_snapshot ?? undefined,
      holdFeePolicySnapshot: row.hold_fee_policy_snapshot ?? undefined,
    };
  }
}
