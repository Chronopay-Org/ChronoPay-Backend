import type {
  CounterAdvanceResult,
  MfaEnrollmentRow,
  MfaRepository,
  NewMfaEnrollment,
} from "../models/mfaEnrollment.js";
import { encryptTotpSecret } from "../services/mfaCrypto.js";

export interface FakeMfaRepositoryHandle {
  repo: MfaRepository;
  rows: Map<string, MfaEnrollmentRow>;
  /** Seeds a verified (active) enrollment for a raw TOTP secret. */
  seedVerified(userId: string, rawSecret: Buffer, masterKey: string, options?: { verified?: boolean }): Promise<MfaEnrollmentRow>;
  upsertRaw(input: NewMfaEnrollment): Promise<MfaEnrollmentRow>;
}

/**
 * In-memory MfaRepository for service/route/middleware tests. Encrypted rows
 * use the real mfaCrypto with the caller-provided master key, so the full
 * encrypt-at-rest path is exercised without a Postgres instance.
 */
export function createFakeMfaRepository(): FakeMfaRepositoryHandle {
  const rows = new Map<string, MfaEnrollmentRow>();

  const touch = (row: MfaEnrollmentRow): MfaEnrollmentRow => {
    row.updated_at = new Date().toISOString();
    return row;
  };

  const repo: MfaRepository = {
    async upsertEnrollment(input) {
      const row: MfaEnrollmentRow = {
        user_id: input.userId,
        secret_ciphertext: input.secretCiphertext,
        secret_iv: input.secretIv,
        secret_auth_tag: input.secretAuthTag,
        kdf_salt: input.kdfSalt,
        algorithm: input.algorithm,
        digits: input.digits,
        period: input.period,
        verified: false,
        last_used_counter: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      rows.set(input.userId, row);
      return { ...row };
    },
    async findByUserId(userId) {
      const row = rows.get(userId);
      return row ? { ...row } : null;
    },
    async markVerified(userId) {
      const row = rows.get(userId);
      if (!row) return false;
      row.verified = true;
      touch(row);
      return true;
    },
    async advanceLastUsedCounter(userId, step): Promise<CounterAdvanceResult> {
      const row = rows.get(userId);
      if (!row) return { advanced: false, enrollment: null };
      if (row.last_used_counter !== null && row.last_used_counter >= step) {
        return { advanced: false, enrollment: null };
      }
      row.last_used_counter = step;
      touch(row);
      return { advanced: true, enrollment: { ...row } };
    },
    async deleteByUserId(userId) {
      return rows.delete(userId);
    },
  };

  const upsertRaw = async (input: NewMfaEnrollment) => repo.upsertEnrollment(input);
  const seedVerified = async (
    userId: string,
    rawSecret: Buffer,
    masterKey: string,
    options?: { verified?: boolean },
  ) => {
    const encrypted = encryptTotpSecret(rawSecret, { masterKey });
    const row = await repo.upsertEnrollment({
      userId,
      secretCiphertext: encrypted.ciphertext.toString("hex"),
      secretIv: encrypted.iv.toString("hex"),
      secretAuthTag: encrypted.authTag.toString("hex"),
      kdfSalt: encrypted.salt.toString("hex"),
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    });
    const stored = rows.get(userId);
    if (stored) {
      stored.verified = options?.verified ?? true;
    }
    return { ...row, verified: stored?.verified ?? false };
  };

  return { repo, rows, seedVerified, upsertRaw };
}

/** Shorthand for tests that don't care about the returned handle. */
export async function flushMicrotasks(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}