import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 018 — create_dispute_mediation_transcripts (Issue #450)
 *
 * Stores envelope-encrypted mediation transcripts for disputes:
 *   - Chat messages between buyers, suppliers, mediators, and observers
 *   - Voice call transcripts (speaker-diarised text, post-transcription)
 *   - Evidence excerpts, mediator private notes, and panel deliberation records
 *
 * Envelope encryption column layout (per-transcript-segment DEK):
 *   - ciphertext: AES-256-GCM of the JSON payload (body + metadata + participant)
 *   - gcm_nonce:  12 random bytes, unique per row
 *   - gcm_tag:    16-byte authentication tag from AES-GCM
 *   - wrapped_dek: Data Encryption Key wrapped with the KEK using AES-256-KW
 *   - kek_version_id: KEK version used to wrap wrapped_dek, needed for rotation
 *
 * Retention (7-year default, jurisdiction-overridable):
 *   - retention_override_jurisdiction: e.g. "gdpr-uk", "finra-us"
 *   - retention_override_ms: raw millisecond override for bespoke cases
 *   - retention_status:   active | retain_pending_purge | purged
 *   - purged_at:          set when the retention sweep scrubs the row
 *
 * Purge policy (see DisputeMediationRetentionRunner): when retention closes,
 * the row is tombstoned and ciphertext/wrapped_dek/nonce/tag are zeroed so
 * the plaintext is unrecoverable even before the row is eventually dropped.
 */
export const migration: Migration = {
  id: "018",
  name: "create_dispute_mediation_transcripts",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE dispute_mediation_transcripts (
        id                             TEXT         PRIMARY KEY,
        dispute_id                     TEXT         NOT NULL,
        kind                           TEXT         NOT NULL CHECK (kind IN ('chat','voice','evidence_excerpt','mediator_note')),
        participant_id                 TEXT         NOT NULL,
        participant_role               TEXT         NOT NULL CHECK (participant_role IN ('buyer','supplier','mediator','senior_arbiter','observer','automation')),
        ciphertext                     BYTEA        NOT NULL,
        gcm_nonce                      BYTEA        NOT NULL CHECK (octet_length(gcm_nonce) = 12),
        gcm_tag                        BYTEA        NOT NULL CHECK (octet_length(gcm_tag) = 16),
        wrapped_dek                    BYTEA        NOT NULL,
        kek_version_id                 TEXT         NOT NULL,
        body_sha256                    TEXT         NOT NULL,
        authored_at                    TIMESTAMPTZ,
        created_at                     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        retention_override_jurisdiction TEXT,
        retention_override_ms          BIGINT,
        retention_status               TEXT         NOT NULL DEFAULT 'active'
                                     CHECK (retention_status IN ('active','retain_pending_purge','purged')),
        purged_at                      TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE INDEX idx_dispute_transcripts_dispute_id_created
        ON dispute_mediation_transcripts (dispute_id, created_at)
        WHERE retention_status != 'purged'
    `);

    await client.query(`
      CREATE INDEX idx_dispute_transcripts_kek_version
        ON dispute_mediation_transcripts (kek_version_id)
        WHERE retention_status != 'purged'
    `);

    await client.query(`
      CREATE INDEX idx_dispute_transcripts_retention_close
        ON dispute_mediation_transcripts (
          COALESCE(
            CASE
              WHEN retention_override_ms IS NOT NULL
                THEN created_at + (retention_override_ms::text || ' ms')::interval
              WHEN retention_override_jurisdiction = 'gdpr-default'
                THEN created_at + interval '3 years'
              WHEN retention_override_jurisdiction = 'finra-us'
                THEN created_at + interval '10 years'
              WHEN retention_override_jurisdiction = 'fca-uk'
                THEN created_at + interval '6 years'
              ELSE created_at + interval '7 years'
            END,
            created_at + interval '7 years'
          )
        )
        WHERE retention_status = 'active'
    `);

    await client.query(`
      COMMENT ON TABLE dispute_mediation_transcripts IS
        'Envelope-encrypted dispute mediation transcripts. 7yr default retention; see Issue #450.'
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS dispute_mediation_transcripts`);
  },
};
