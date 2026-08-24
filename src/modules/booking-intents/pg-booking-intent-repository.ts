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
        updated_at,
        anomaly_score,
        anomaly_flagged,
        anomaly_signals
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, $10, $11)
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
      intent.anomalyScore ?? null,
      intent.anomalyFlagged ?? false,
      intent.anomalySignals ? JSON.stringify(intent.anomalySignals) : null,
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

  async listByCustomer(customerId: string): Promise<BookingIntentRecord[]> {
    const sql = `SELECT * FROM booking_intents WHERE customer_id = $1 ORDER BY created_at ASC`;
    const res = await this.dbQuery(sql, [customerId]);
    return res.rows.map((row: any) => this.mapRowToRecord(row));
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
      anomalyScore: row.anomaly_score ?? undefined,
      anomalyFlagged: row.anomaly_flagged ?? undefined,
      anomalySignals: row.anomaly_signals
        ? typeof row.anomaly_signals === "string"
          ? JSON.parse(row.anomaly_signals)
          : row.anomaly_signals
        : undefined,
    };
  }
}
