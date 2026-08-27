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

  async findBySlotId(slotId: string): Promise<BookingIntentRecord | undefined> {
    const sql = `SELECT * FROM booking_intents WHERE slot_id = $1 LIMIT 1`;
    const res = await this.dbQuery(sql, [slotId]);
    return res.rows[0] ? this.mapRowToRecord(res.rows[0]) : undefined;
  }

  async findById(id: string): Promise<BookingIntentRecord | undefined> {
    const sql = `SELECT * FROM booking_intents WHERE id = $1 LIMIT 1`;
    const res = await this.dbQuery(sql, [id]);
    return res.rows[0] ? this.mapRowToRecord(res.rows[0]) : undefined;
  }

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

  async updateStatus(id: string, status: BookingIntentStatus): Promise<BookingIntentRecord> {
    const sql = `UPDATE booking_intents SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`;
    const res = await this.dbQuery(sql, [id, status]);
    return this.mapRowToRecord(res.rows[0]);
  }

  async update(id: string, updates: Partial<Omit<BookingIntentRecord, "id">>): Promise<BookingIntentRecord> {
    const fields: string[] = [];
    const values: any[] = [id];
    let paramIdx = 2;
    if (updates.status !== undefined) { fields.push(`status = $${paramIdx++}`); values.push(updates.status); }
    if (updates.note !== undefined) { fields.push(`note = $${paramIdx++}`); values.push(updates.note); }
    fields.push(`updated_at = NOW()`);
    const sql = `UPDATE booking_intents SET ${fields.join(", ")} WHERE id = $1 RETURNING *`;
    const res = await this.dbQuery(sql, values);
    return this.mapRowToRecord(res.rows[0]);
  }

  async findExpiredHolds(nowMs: number): Promise<BookingIntentRecord[]> {
    const sql = `SELECT * FROM booking_intents WHERE status = 'hold_placed' AND hold_until_ms < $1`;
    const res = await this.dbQuery(sql, [nowMs]);
    return res.rows.map((row: any) => this.mapRowToRecord(row));
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
