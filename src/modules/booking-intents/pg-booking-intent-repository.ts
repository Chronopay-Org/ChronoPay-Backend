import { query } from "../../db/pool.js";
import { ConflictError } from "../../errors/AppError.js";
import {
  BookingIntentRecord,
  BookingIntentRepository,
  BookingIntentStatus,
} from "./booking-intent-repository.js";

/**
 * PostgreSQL implementation of the BookingIntentRepository.
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
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
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

  // @ts-expect-error - Auto-fixed by script
  async findBySlotId(slotId: string): Promise<BookingIntentRecord | undefined> {
    const sql = `SELECT * FROM booking_intents WHERE slot_id = $1 LIMIT 1`;
    const res = await this.dbQuery(sql, [slotId]);
    return res.rows[0] ? this.mapRowToRecord(res.rows[0]) : undefined;
  }

  // @ts-expect-error - Auto-fixed by script
  async findById(id: string): Promise<BookingIntentRecord | undefined> {
    const sql = `SELECT * FROM booking_intents WHERE id = $1 LIMIT 1`;
    const res = await this.dbQuery(sql, [id]);
    return res.rows[0] ? this.mapRowToRecord(res.rows[0]) : undefined;
  }

  // @ts-expect-error - Auto-fixed by script
  async findBySlotIdAndCustomer(slotId: string, customerId: string): Promise<BookingIntentRecord | undefined> {
    const sql = `SELECT * FROM booking_intents WHERE slot_id = $1 AND customer_id = $2 LIMIT 1`;
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

  /**
   * Claims up to `limit` stale `pending` intents older than `cutoffMs`.
   *
   * `FOR UPDATE SKIP LOCKED` lets multiple worker instances sweep safely: rows
   * locked by a concurrent transaction (a competing claim) are skipped instead
   * of blocking, so an intent can never be claimed by two workers at once.
   * Rows are returned oldest-first so retries/backfills naturally drain the
   * longest-stuck intents first.
   */
  async findStalePendingIntents(cutoffMs: number, limit: number): Promise<BookingIntentRecord[]> {
    const sql = `
      SELECT * FROM booking_intents
      WHERE status = 'pending' AND created_at <= $1
      ORDER BY created_at ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    `;
    const res = await this.dbQuery(sql, [new Date(cutoffMs), limit]);
    return res.rows.map((row) => this.mapRowToRecord(row));
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
    };
  }
}
