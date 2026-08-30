import type { QueryResult } from "pg";
import type {
  CounterAdvanceResult,
  MfaEnrollmentRow,
  MfaRepository,
  NewMfaEnrollment,
} from "../models/mfaEnrollment.js";

type DbQuery = (text: string, params?: unknown[]) => Promise<QueryResult>;

const defaultDbQuery: DbQuery = async (text, params) => {
  const { query } = await import("../db/pool.js");
  return query(text, params);
};

let defaultRepository: MfaRepository | null = null;

/** Returns the process-wide MFA repository singleton. */
export function getMfaRepository(): MfaRepository {
  if (!defaultRepository) {
    defaultRepository = new PgMfaRepository();
  }
  return defaultRepository;
}

/** Test seam: inject a fake repository (or null to restore the default). */
export function setMfaRepositoryForTests(repository: MfaRepository | null): void {
  defaultRepository = repository;
}

function mapRow(row: Record<string, unknown>): MfaEnrollmentRow {
  return {
    user_id: String(row.user_id),
    secret_ciphertext: String(row.secret_ciphertext),
    secret_iv: String(row.secret_iv),
    secret_auth_tag: String(row.secret_auth_tag),
    kdf_salt: String(row.kdf_salt),
    algorithm: String(row.algorithm ?? "SHA1"),
    digits: Number(row.digits ?? 6),
    period: Number(row.period ?? 30),
    verified: Boolean(row.verified),
    last_used_counter: row.last_used_counter === null || row.last_used_counter === undefined
      ? null
      : Number(row.last_used_counter),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export class PgMfaRepository implements MfaRepository {
  constructor(private readonly dbQuery: DbQuery = defaultDbQuery) {}

  async upsertEnrollment(input: NewMfaEnrollment): Promise<MfaEnrollmentRow> {
    const result = await this.dbQuery(
      `
        INSERT INTO mfa_enrollments (
          user_id,
          secret_ciphertext,
          secret_iv,
          secret_auth_tag,
          kdf_salt,
          algorithm,
          digits,
          period,
          verified,
          last_used_counter,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, NULL, NOW(), NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET
          secret_ciphertext = EXCLUDED.secret_ciphertext,
          secret_iv = EXCLUDED.secret_iv,
          secret_auth_tag = EXCLUDED.secret_auth_tag,
          kdf_salt = EXCLUDED.kdf_salt,
          algorithm = EXCLUDED.algorithm,
          digits = EXCLUDED.digits,
          period = EXCLUDED.period,
          verified = FALSE,
          last_used_counter = NULL,
          updated_at = NOW()
        RETURNING *
      `,
      [
        input.userId,
        input.secretCiphertext,
        input.secretIv,
        input.secretAuthTag,
        input.kdfSalt,
        input.algorithm,
        input.digits,
        input.period,
      ],
    );

    return mapRow(result.rows[0]);
  }

  async findByUserId(userId: string): Promise<MfaEnrollmentRow | null> {
    const result = await this.dbQuery(
      `SELECT * FROM mfa_enrollments WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async markVerified(userId: string): Promise<boolean> {
    const result = await this.dbQuery(
      `
        UPDATE mfa_enrollments
        SET verified = TRUE, updated_at = NOW()
        WHERE user_id = $1
      `,
      [userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async advanceLastUsedCounter(userId: string, step: number): Promise<CounterAdvanceResult> {
    const result = await this.dbQuery(
      `
        UPDATE mfa_enrollments
        SET last_used_counter = $2, updated_at = NOW()
        WHERE user_id = $1
          AND (last_used_counter IS NULL OR last_used_counter < $2)
        RETURNING *
      `,
      [userId, step],
    );

    if ((result.rowCount ?? 0) === 0 || !result.rows[0]) {
      return { advanced: false, enrollment: null };
    }

    return { advanced: true, enrollment: mapRow(result.rows[0]) };
  }

  async deleteByUserId(userId: string): Promise<boolean> {
    const result = await this.dbQuery(`DELETE FROM mfa_enrollments WHERE user_id = $1`, [userId]);
    return (result.rowCount ?? 0) > 0;
  }
}