/**
 * disputeMediationTranscriptStore.ts (Issue #450)
 *
 * Durable, envelope-encrypted store for dispute mediation transcripts:
 *   - Chat messages between parties, mediators, and observers
 *   - Voice call transcripts (post-transcription text with speaker labels)
 *   - Attached evidence excerpts, annotations, and internal mediator notes
 *
 * ## Cryptographic design
 *
 * Envelope encryption (two-tier):
 *   1. Each transcript session gets a unique 256-bit Data Encryption Key (DEK).
 *   2. The DEK encrypts transcript payloads in AES-256-GCM (authenticated).
 *   3. The DEK itself is wrapped by a Key Encryption Key (KEK) using AES-256-KW.
 *   4. Only the wrapped DEK is persisted alongside the ciphertext; the plain
 *      DEK is never written to the DB, only held ephemerally in-memory per call.
 *
 * KEK rotation is supported without re-reading plaintext: the wrapped DEK is
 * unwrapped with the old KEK and re-wrapped with the new KEK. The ciphertext
 * itself is untouched — this is the same pattern used by kekRotationRunner.ts
 * for other envelope-encrypted tables.
 *
 * ## Retention
 *
 * Default retention is 7 years from transcript creation (regulatory default).
 * Individual jurisdictions can override via `retentionOverrideJurisdiction`
 * stored per-transcript (e.g. GDPR requires shorter retention in some cases,
 * while financial-jurisdiction regulators require longer).
 *
 * A sweep job (see `DisputeMediationRetentionRunner`) hard-deletes or
 * tombstone-purges transcripts whose retention window has closed.
 */

import crypto from "crypto";
import { EventEmitter } from "node:events";
import type { Pool, PoolClient } from "pg";
import { Counter, Gauge } from "prom-client";

// ─── Constants ────────────────────────────────────────────────────────────────

export const AES_KEY_BYTES = 32;
export const GCM_IV_BYTES = 12;
export const GCM_TAG_BYTES = 16;

export const DEFAULT_RETENTION_MS = 7 * 365 * 24 * 60 * 60 * 1000;

export type TranscriptKind = "chat" | "voice" | "evidence_excerpt" | "mediator_note";
export type TranscriptParticipantRole =
  | "buyer"
  | "supplier"
  | "mediator"
  | "senior_arbiter"
  | "observer"
  | "automation";

export type TranscriptRetentionStatus = "active" | "retain_pending_purge" | "purged";

// ─── Metrics ──────────────────────────────────────────────────────────────────

export const transcriptsEncryptedTotal = new Counter({
  name: "dispute_transcripts_encrypted_total",
  help: "Total transcript segments encrypted and written",
  labelNames: ["kind"] as const,
});

export const transcriptsDecryptedTotal = new Counter({
  name: "dispute_transcripts_decrypted_total",
  help: "Total transcript segments successfully decrypted and read",
  labelNames: ["kind"] as const,
});

export const transcriptsRetentionPurgedTotal = new Counter({
  name: "dispute_transcripts_retention_purged_total",
  help: "Total transcript segments purged by the retention sweep",
  labelNames: ["jurisdiction"] as const,
});

export const transcriptKekVersionGauge = new Gauge({
  name: "dispute_transcript_kek_version_id",
  help: "The active KEK version identifier used for new wraps",
  labelNames: ["store_id"] as const,
});

// ─── Domain types ─────────────────────────────────────────────────────────────

export interface TranscriptParticipant {
  id: string;
  role: TranscriptParticipantRole;
  displayName?: string;
  tenantId?: string;
}

export interface PlaintextTranscriptSegment {
  id: string;
  disputeId: string;
  kind: TranscriptKind;
  participant: TranscriptParticipant;
  /** Plaintext content.  For voice transcripts this is the speaker-diarised text. */
  body: string;
  /** Optional ISO-8601 timestamp for when the message / utterance was authored. */
  authoredAtIso?: string;
  /** Opaque structured metadata (e.g. voice transcription confidence, attachment refs). */
  metadata?: Record<string, unknown>;
}

export interface StoredEncryptedTranscript {
  id: string;
  disputeId: string;
  kind: TranscriptKind;
  participantId: string;
  participantRole: TranscriptParticipantRole;
  /** AES-256-GCM ciphertext (body + metadata JSON). */
  ciphertext: Buffer;
  /** 12-byte GCM IV — unique per encrypt() call. */
  gcmNonce: Buffer;
  /** 16-byte GCM authentication tag. */
  gcmTag: Buffer;
  /** DEK wrapped with the current KEK using AES-256-KW. */
  wrappedDek: Buffer;
  /** KEK version identifier that wrapped `wrappedDek`.  Used by rotation jobs. */
  kekVersionId: string;
  /** SHA-256 of the PLAINTEXT body (for optional dedup, never the content itself). */
  bodySha256: string;
  /** ISO-8601 wall-clock when the segment was ingested. */
  createdAtIso: string;
  authoredAtIso?: string;
  /** Optional jurisdiction tag for retention overrides (e.g. "gdpr-uk", "finra-us"). */
  retentionOverrideJurisdiction?: string;
  /** Optional retention override in ms; if unset defaults to DEFAULT_RETENTION_MS. */
  retentionOverrideMs?: number;
  retentionStatus: TranscriptRetentionStatus;
  purgedAtIso?: string;
}

// ─── KMS / KEK abstraction (injected so tests can supply a mock) ──────────────

export interface KekVersion {
  id: string;
}

export interface TranscriptKms {
  wrapDek(plainDek: Buffer, kek: KekVersion): Promise<Buffer>;
  unwrapDek(wrappedDek: Buffer, kek: KekVersion): Promise<Buffer>;
}

export interface ActiveKekProvider {
  getActiveKek(): Promise<KekVersion>;
  getKekById(id: string): Promise<KekVersion>;
}

// ─── Encryption primitives ────────────────────────────────────────────────────

export function generateDek(): Buffer {
  return crypto.randomBytes(AES_KEY_BYTES);
}

export function generateGcmNonce(): Buffer {
  return crypto.randomBytes(GCM_IV_BYTES);
}

export interface EncryptSegmentOutput {
  ciphertext: Buffer;
  gcmNonce: Buffer;
  gcmTag: Buffer;
  wrappedDek: Buffer;
  kekVersionId: string;
  bodySha256: string;
}

export async function encryptSegment(
  segment: PlaintextTranscriptSegment,
  kms: TranscriptKms,
  activeKek: KekVersion,
  explicitDek?: Buffer,
): Promise<EncryptSegmentOutput> {
  const payload = JSON.stringify({
    body: segment.body,
    metadata: segment.metadata ?? null,
    participant: segment.participant,
    _ver: 1,
  });

  const plainDek = explicitDek ?? generateDek();
  const nonce = generateGcmNonce();
  const cipher = crypto.createCipheriv("aes-256-gcm", plainDek, nonce);
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const gcmTag = cipher.getAuthTag();
  const wrappedDek = await kms.wrapDek(plainDek, activeKek);
  const bodySha256 = crypto.createHash("sha256").update(segment.body, "utf8").digest("hex");

  plainDek.fill(0);

  return {
    ciphertext,
    gcmNonce: nonce,
    gcmTag,
    wrappedDek,
    kekVersionId: activeKek.id,
    bodySha256,
  };
}

export async function decryptSegment(
  stored: StoredEncryptedTranscript,
  kms: TranscriptKms,
  kekProvider: ActiveKekProvider,
): Promise<PlaintextTranscriptSegment> {
  const kek = await kekProvider.getKekById(stored.kekVersionId);
  const plainDek = await kms.unwrapDek(stored.wrappedDek, kek);

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", plainDek, stored.gcmNonce);
    decipher.setAuthTag(stored.gcmTag);
    const plaintext = Buffer.concat([
      decipher.update(stored.ciphertext),
      decipher.final(),
    ]).toString("utf8");

    const payload = JSON.parse(plaintext) as {
      body: string;
      metadata: Record<string, unknown> | null;
      participant: TranscriptParticipant;
    };

    return {
      id: stored.id,
      disputeId: stored.disputeId,
      kind: stored.kind,
      participant: payload.participant,
      body: payload.body,
      metadata: payload.metadata ?? undefined,
      authoredAtIso: stored.authoredAtIso,
    };
  } finally {
    plainDek.fill(0);
  }
}

// ─── Retention math ───────────────────────────────────────────────────────────

export interface RetentionWindow {
  closeAtMs: number;
  sourceMs: number;
  overrideMs?: number;
  overrideJurisdiction?: string;
}

const JURISDICTION_RETENTION_OVERRIDES: Record<string, number> = {
  "gdpr-default": 3 * 365 * 24 * 60 * 60 * 1000,
  "finra-us": 10 * 365 * 24 * 60 * 60 * 1000,
  "fca-uk": 6 * 365 * 24 * 60 * 60 * 1000,
};

export function computeRetentionClose(
  createdAtMs: number,
  overrideJurisdiction?: string,
  overrideMs?: number,
): RetentionWindow {
  if (overrideMs !== undefined && Number.isFinite(overrideMs) && overrideMs > 0) {
    return {
      closeAtMs: createdAtMs + overrideMs,
      sourceMs: overrideMs,
      overrideMs,
      overrideJurisdiction,
    };
  }
  if (overrideJurisdiction && JURISDICTION_RETENTION_OVERRIDES[overrideJurisdiction]) {
    const ms = JURISDICTION_RETENTION_OVERRIDES[overrideJurisdiction];
    return {
      closeAtMs: createdAtMs + ms,
      sourceMs: ms,
      overrideJurisdiction,
    };
  }
  return {
    closeAtMs: createdAtMs + DEFAULT_RETENTION_MS,
    sourceMs: DEFAULT_RETENTION_MS,
  };
}

// ─── Repository interface (DB-backed in prod, in-memory in tests) ─────────────

export interface TranscriptRepository {
  insert(client: PoolClient, stored: StoredEncryptedTranscript): Promise<void>;
  findById(client: PoolClient, id: string): Promise<StoredEncryptedTranscript | null>;
  listByDispute(client: PoolClient, disputeId: string): Promise<StoredEncryptedTranscript[]>;
  purgeExpired(
    client: PoolClient,
    nowMs: number,
    limit: number,
  ): Promise<{ purgedCount: number; purgedIds: string[] }>;
}

// ─── In-memory repository (safe for tests + dev) ──────────────────────────────

export class InMemoryTranscriptRepository implements TranscriptRepository {
  private rows = new Map<string, StoredEncryptedTranscript>();

  async insert(_client: PoolClient, stored: StoredEncryptedTranscript): Promise<void> {
    this.rows.set(stored.id, { ...stored });
  }

  async findById(_client: PoolClient, id: string): Promise<StoredEncryptedTranscript | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async listByDispute(_client: PoolClient, disputeId: string): Promise<StoredEncryptedTranscript[]> {
    const out: StoredEncryptedTranscript[] = [];
    for (const row of this.rows.values()) {
      if (row.disputeId === disputeId && row.retentionStatus !== "purged") {
        out.push({ ...row });
      }
    }
    return out.sort((a, b) => (a.createdAtIso < b.createdAtIso ? -1 : 1));
  }

  async purgeExpired(
    _client: PoolClient,
    nowMs: number,
    limit: number,
  ): Promise<{ purgedCount: number; purgedIds: string[] }> {
    const purgedIds: string[] = [];
    let count = 0;
    for (const row of this.rows.values()) {
      if (count >= limit) break;
      if (row.retentionStatus === "purged") continue;
      const createdMs = new Date(row.createdAtIso).getTime();
      const { closeAtMs } = computeRetentionClose(
        createdMs,
        row.retentionOverrideJurisdiction,
        row.retentionOverrideMs,
      );
      if (nowMs >= closeAtMs) {
        row.retentionStatus = "purged";
        row.purgedAtIso = new Date(nowMs).toISOString();
        row.ciphertext = Buffer.alloc(0);
        row.wrappedDek = Buffer.alloc(0);
        row.gcmNonce = Buffer.alloc(0);
        row.gcmTag = Buffer.alloc(0);
        purgedIds.push(row.id);
        count++;
      }
    }
    return { purgedCount: count, purgedIds };
  }

  /** For tests only — direct row count. */
  _size(): number {
    return this.rows.size;
  }

  /** For tests only. */
  _clear(): void {
    this.rows.clear();
  }
}

// ─── In-memory KMS (for tests; real deployment would call AWS KMS / Vault) ───

const AES_KW_IV = Buffer.from("A6A6A6A6A6A6A6A6A", "hex");

export function aesKeyWrap(plainKey: Buffer, kek: Buffer): Buffer {
  const n = plainKey.length / 8;
  if (!Number.isInteger(n) || n < 1) throw new Error("Plain key length must be multiple of 8 bytes");

  const R = new Array<Buffer>(n + 1);
  for (let i = 1; i <= n; i++) R[i] = plainKey.subarray((i - 1) * 8, i * 8);
  let A = Buffer.from(AES_KW_IV);

  for (let j = 0; j <= 5; j++) {
    for (let i = 1; i <= n; i++) {
      const cipher = crypto.createCipheriv("aes-256-ecb", kek, null);
      cipher.setAutoPadding(false);
      const concat = Buffer.concat([A, R[i]]);
      const B = Buffer.concat([cipher.update(concat), cipher.final()]);
      const t = BigInt(n * j + i);
      A = Buffer.alloc(8);
      for (let k = 0; k < 8; k++) {
        A[k] = B[k] ^ (k >= 7 ? Number(t & 0xffn) : 0);
      }
      let shift = 56n;
      for (let k = 7; k >= 0; k--) {
        A[k] = B[k] ^ Number((t >> shift) & 0xffn);
        shift -= 8n;
      }
      R[i] = B.subarray(8, 16);
    }
  }

  const output = Buffer.alloc(8 * (n + 1));
  A.copy(output, 0);
  for (let i = 1; i <= n; i++) R[i].copy(output, i * 8);
  return output;
}

export function aesKeyUnwrap(wrapped: Buffer, kek: Buffer): Buffer {
  const n = wrapped.length / 8 - 1;
  if (!Number.isInteger(n) || n < 1) throw new Error("Wrapped key length invalid");

  const R = new Array<Buffer>(n + 1);
  for (let i = 1; i <= n; i++) R[i] = wrapped.subarray(i * 8, (i + 1) * 8);
  let A = wrapped.subarray(0, 8);

  for (let j = 5; j >= 0; j--) {
    for (let i = n; i >= 1; i--) {
      const t = BigInt(n * j + i);
      const AxorT = Buffer.alloc(8);
      let shift = 56n;
      for (let k = 0; k < 8; k++) {
        AxorT[k] = A[k] ^ Number((t >> shift) & 0xffn);
        shift -= 8n;
      }
      const concat = Buffer.concat([AxorT, R[i]]);
      const decipher = crypto.createDecipheriv("aes-256-ecb", kek, null);
      decipher.setAutoPadding(false);
      const B = Buffer.concat([decipher.update(concat), decipher.final()]);
      A = B.subarray(0, 8);
      R[i] = B.subarray(8, 16);
    }
  }

  if (!A.equals(AES_KW_IV)) {
    throw new Error("AES-KW unwrap integrity check failed — bad KEK or corrupt wrapped DEK");
  }

  const out = Buffer.alloc(n * 8);
  for (let i = 1; i <= n; i++) R[i].copy(out, (i - 1) * 8);
  return out;
}

export class InMemoryTranscriptKms implements TranscriptKms {
  private readonly kekKeys = new Map<string, Buffer>();

  registerKek(id: string, material?: Buffer): this {
    this.kekKeys.set(id, material ?? crypto.randomBytes(AES_KEY_BYTES));
    return this;
  }

  async wrapDek(plainDek: Buffer, kek: KekVersion): Promise<Buffer> {
    const key = this.kekKeys.get(kek.id);
    if (!key) throw new Error(`Unknown KEK id: ${kek.id}`);
    return aesKeyWrap(plainDek, key);
  }

  async unwrapDek(wrappedDek: Buffer, kek: KekVersion): Promise<Buffer> {
    const key = this.kekKeys.get(kek.id);
    if (!key) throw new Error(`Unknown KEK id: ${kek.id}`);
    return aesKeyUnwrap(wrappedDek, key);
  }
}

export class InMemoryActiveKekProvider implements ActiveKekProvider {
  private active: KekVersion;
  private byId = new Map<string, KekVersion>();

  constructor(initialActive: KekVersion = { id: "kek-v1" }) {
    this.active = initialActive;
    this.byId.set(initialActive.id, initialActive);
  }

  register(kek: KekVersion): this {
    this.byId.set(kek.id, kek);
    return this;
  }

  setActive(kek: KekVersion): this {
    this.byId.set(kek.id, kek);
    this.active = kek;
    return this;
  }

  async getActiveKek(): Promise<KekVersion> {
    return this.active;
  }

  async getKekById(id: string): Promise<KekVersion> {
    const kek = this.byId.get(id);
    if (!kek) throw new Error(`Unknown KEK id: ${id}`);
    return kek;
  }
}

// ─── Store service (the facade used by HTTP handlers / business code) ─────────

export const transcriptStoreEvents = new EventEmitter();

export class DisputeMediationTranscriptStore {
  private readonly storeId: string;

  constructor(
    private readonly pool: Pool,
    private readonly kms: TranscriptKms,
    private readonly kekProvider: ActiveKekProvider,
    private readonly repository: TranscriptRepository = new InMemoryTranscriptRepository(),
    options: { storeId?: string } = {},
  ) {
    this.storeId = options.storeId ?? "dispute-mediation-v1";
  }

  async appendSegment(
    segment: PlaintextTranscriptSegment,
    opts: {
      retentionOverrideJurisdiction?: string;
      retentionOverrideMs?: number;
      client?: PoolClient;
      nowIso?: string;
    } = {},
  ): Promise<StoredEncryptedTranscript> {
    const activeKek = await this.kekProvider.getActiveKek();
    transcriptKekVersionGauge.set({ store_id: this.storeId }, parseInt(activeKek.id.replace(/\D/g, "")) || 0);

    const encrypted = await encryptSegment(segment, this.kms, activeKek);

    const nowIso = opts.nowIso ?? new Date().toISOString();
    const stored: StoredEncryptedTranscript = {
      id: segment.id,
      disputeId: segment.disputeId,
      kind: segment.kind,
      participantId: segment.participant.id,
      participantRole: segment.participant.role,
      ciphertext: encrypted.ciphertext,
      gcmNonce: encrypted.gcmNonce,
      gcmTag: encrypted.gcmTag,
      wrappedDek: encrypted.wrappedDek,
      kekVersionId: encrypted.kekVersionId,
      bodySha256: encrypted.bodySha256,
      createdAtIso: nowIso,
      authoredAtIso: segment.authoredAtIso,
      retentionOverrideJurisdiction: opts.retentionOverrideJurisdiction,
      retentionOverrideMs: opts.retentionOverrideMs,
      retentionStatus: "active",
    };

    const client = opts.client ?? ((await this.pool.connect()) as PoolClient);
    const owned = !opts.client;
    try {
      if (owned) await client.query("BEGIN");
      await this.repository.insert(client, stored);
      if (owned) await client.query("COMMIT");
    } catch (err) {
      if (owned) await client.query("ROLLBACK");
      throw err;
    } finally {
      if (owned) client.release();
    }

    transcriptsEncryptedTotal.inc({ kind: segment.kind });
    transcriptStoreEvents.emit("segment.appended", { id: stored.id, disputeId: stored.disputeId });
    return stored;
  }

  async getSegment(id: string, opts: { client?: PoolClient } = {}): Promise<PlaintextTranscriptSegment | null> {
    const client = opts.client ?? ((await this.pool.connect()) as PoolClient);
    const owned = !opts.client;
    try {
      const stored = await this.repository.findById(client, id);
      if (!stored || stored.retentionStatus === "purged") return null;
      const plain = await decryptSegment(stored, this.kms, this.kekProvider);
      transcriptsDecryptedTotal.inc({ kind: stored.kind });
      return plain;
    } finally {
      if (owned) client.release();
    }
  }

  async listDisputeSegments(
    disputeId: string,
    opts: { client?: PoolClient } = {},
  ): Promise<PlaintextTranscriptSegment[]> {
    const client = opts.client ?? ((await this.pool.connect()) as PoolClient);
    const owned = !opts.client;
    try {
      const stored = await this.repository.listByDispute(client, disputeId);
      const out: PlaintextTranscriptSegment[] = [];
      for (const s of stored) {
        out.push(await decryptSegment(s, this.kms, this.kekProvider));
        transcriptsDecryptedTotal.inc({ kind: s.kind });
      }
      return out;
    } finally {
      if (owned) client.release();
    }
  }
}

// ─── Retention sweep runner (issue #450 — 7-year default retention) ──────────

export class DisputeMediationRetentionRunner {
  constructor(
    private readonly pool: Pool,
    private readonly repository: TranscriptRepository = new InMemoryTranscriptRepository(),
    private readonly options: { batchLimit?: number } = {},
  ) {}

  async runOnce(nowMs: number): Promise<{ purgedCount: number; purgedIds: string[] }> {
    const limit = this.options.batchLimit ?? 500;
    const client = (await this.pool.connect()) as PoolClient;
    try {
      await client.query("BEGIN");
      const result = await this.repository.purgeExpired(client, nowMs, limit);
      await client.query("COMMIT");

      const jurisdictionCounts = new Map<string, number>();
      for (const id of result.purgedIds) {
        const row = await this.repository.findById(client, id);
        const j = row?.retentionOverrideJurisdiction ?? "default-7y";
        jurisdictionCounts.set(j, (jurisdictionCounts.get(j) ?? 0) + 1);
        transcriptsRetentionPurgedTotal.inc({ jurisdiction: j });
      }

      transcriptStoreEvents.emit("retention.sweep", {
        nowMs,
        purgedCount: result.purgedCount,
        jurisdictionCounts: Object.fromEntries(jurisdictionCounts),
      });

      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
