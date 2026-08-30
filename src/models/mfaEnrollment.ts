/**
 * MFA enrollment row model + repository contract.
 *
 * The repository is the only code that touches the `mfa_enrollments` table.
 * Following the repo's established pattern, the production implementation uses
 * the shared `pg` pool (injected for testability) and a test seam
 * (`setMfaRepositoryForTests`) lets services/routes be tested without a DB.
 */

export interface MfaEnrollmentRow {
  user_id: string;
  secret_ciphertext: string;
  secret_iv: string;
  secret_auth_tag: string;
  kdf_salt: string;
  algorithm: string;
  digits: number;
  period: number;
  verified: boolean;
  last_used_counter: number | null;
  created_at: string;
  updated_at: string;
}

export interface NewMfaEnrollment {
  userId: string;
  secretCiphertext: string;
  secretIv: string;
  secretAuthTag: string;
  kdfSalt: string;
  algorithm: string;
  digits: number;
  period: number;
}

/**
 * Result of the conditional last-counter update. `advanced` is true only when
 * the stored counter was behind the submitted step (i.e. the request won the
 * replay race); `stale` rows indicate a replay attempt.
 */
export interface CounterAdvanceResult {
  advanced: boolean;
  enrollment: MfaEnrollmentRow | null;
}

export interface MfaRepository {
  /** Creates or replaces a pending (unverified) enrollment. */
  upsertEnrollment(input: NewMfaEnrollment): Promise<MfaEnrollmentRow>;
  findByUserId(userId: string): Promise<MfaEnrollmentRow | null>;
  /** Marks an enrollment verified (used on first successful code check). */
  markVerified(userId: string): Promise<boolean>;
  /**
   * Atomically advances `last_used_counter` only if it is still below the
   * submitted step. Returns `{ advanced: true }` on success or
   * `{ advanced: false }` when the step is a replay / concurrent duplicate.
   */
  advanceLastUsedCounter(userId: string, step: number): Promise<CounterAdvanceResult>;
  deleteByUserId(userId: string): Promise<boolean>;
}