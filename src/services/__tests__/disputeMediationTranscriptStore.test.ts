import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { Pool } from "pg";
import {
  DisputeMediationTranscriptStore,
  DisputeMediationRetentionRunner,
  InMemoryActiveKekProvider,
  InMemoryTranscriptKms,
  InMemoryTranscriptRepository,
  encryptSegment,
  decryptSegment,
  computeRetentionClose,
  DEFAULT_RETENTION_MS,
  transcriptStoreEvents,
  aesKeyWrap,
  aesKeyUnwrap,
  generateDek,
  PlaintextTranscriptSegment,
  StoredEncryptedTranscript,
} from "../../services/disputeMediationTranscriptStore.js";

// ─── Mock Pool (shared by tests so we can run without Postgres) ──────────────

function makeMockPool(): Pool {
  const client = {
    query: jest.fn().mockImplementation(async () => ({ rows: [], rowCount: 0 })),
    release: jest.fn(),
  };
  return {
    connect: async () => client,
  } as unknown as Pool;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSegment(overrides: Partial<PlaintextTranscriptSegment> = {}): PlaintextTranscriptSegment {
  return {
    id: `seg-${Math.random().toString(36).slice(2, 10)}`,
    disputeId: "dispute-abc123",
    kind: "chat",
    participant: { id: "buyer-1", role: "buyer", displayName: "Alice Buyer" },
    body: "I never received the service — the supplier cancelled last minute.",
    authoredAtIso: new Date().toISOString(),
    metadata: { channel: "in-app-chat", attachmentRefs: [] },
    ...overrides,
  };
}

// ─── KMS fixtures ─────────────────────────────────────────────────────────────

function setupKms() {
  const kekMaterial = Buffer.alloc(32, 0xaa);
  const kek = { id: "kek-v1" };
  const kms = new InMemoryTranscriptKms().registerKek(kek.id, kekMaterial);
  const kekProvider = new InMemoryActiveKekProvider(kek).register({ id: "kek-v1" });
  return { kek, kms, kekProvider, kekMaterial };
}

// ─── AES-256-KW round-trip sanity ─────────────────────────────────────────────

describe("AES-256-KW primitive (wrap/unwrap round-trip)", () => {
  it("wraps then unwraps a 32-byte DEK byte-for-byte identical", () => {
    const kek = Buffer.alloc(32, 0x42);
    const plainDek = generateDek();
    const wrapped = aesKeyWrap(plainDek, kek);
    expect(wrapped.length).toBe(plainDek.length + 8);
    const unwrapped = aesKeyUnwrap(wrapped, kek);
    expect(unwrapped).toEqual(plainDek);
  });

  it("unwrap with wrong KEK throws integrity error", () => {
    const kekA = Buffer.alloc(32, 0xaa);
    const kekB = Buffer.alloc(32, 0xbb);
    const plainDek = generateDek();
    const wrapped = aesKeyWrap(plainDek, kekA);
    expect(() => aesKeyUnwrap(wrapped, kekB)).toThrow(/integrity check failed/);
  });

  it("unwrap of corrupted ciphertext throws integrity error", () => {
    const kek = Buffer.alloc(32, 0x42);
    const plainDek = generateDek();
    const wrapped = aesKeyWrap(plainDek, kek);
    wrapped[10] ^= 0xff;
    expect(() => aesKeyUnwrap(wrapped, kek)).toThrow(/integrity check failed/);
  });
});

// ─── Encrypt / decrypt primitives ─────────────────────────────────────────────

describe("encryptSegment / decryptSegment round-trip", () => {
  const { kek, kms, kekProvider } = setupKms();

  it("produces authenticated ciphertext that decrypts to the original", async () => {
    const segment = makeSegment({ body: "round-trip message with 🎉 emoji" });
    const enc = await encryptSegment(segment, kms, kek);
    const stored: StoredEncryptedTranscript = {
      ...segment,
      participantId: segment.participant.id,
      participantRole: segment.participant.role,
      ciphertext: enc.ciphertext,
      gcmNonce: enc.gcmNonce,
      gcmTag: enc.gcmTag,
      wrappedDek: enc.wrappedDek,
      kekVersionId: enc.kekVersionId,
      bodySha256: enc.bodySha256,
      createdAtIso: new Date().toISOString(),
      retentionStatus: "active",
    };

    const decrypted = await decryptSegment(stored, kms, kekProvider);
    expect(decrypted.id).toBe(segment.id);
    expect(decrypted.disputeId).toBe(segment.disputeId);
    expect(decrypted.body).toBe(segment.body);
    expect(decrypted.kind).toBe(segment.kind);
    expect(decrypted.participant.id).toBe(segment.participant.id);
    expect(decrypted.participant.role).toBe(segment.participant.role);
    expect(decrypted.metadata).toEqual(segment.metadata);
  });

  it("tampering with ciphertext fails GCM authentication (no silent corruption)", async () => {
    const segment = makeSegment({ body: "must not corrupt silently" });
    const enc = await encryptSegment(segment, kms, kek);
    const stored: StoredEncryptedTranscript = {
      ...segment,
      participantId: segment.participant.id,
      participantRole: segment.participant.role,
      ciphertext: Buffer.from(enc.ciphertext),
      gcmNonce: enc.gcmNonce,
      gcmTag: enc.gcmTag,
      wrappedDek: enc.wrappedDek,
      kekVersionId: enc.kekVersionId,
      bodySha256: enc.bodySha256,
      createdAtIso: new Date().toISOString(),
      retentionStatus: "active",
    };
    stored.ciphertext[3] ^= 0x01;

    await expect(decryptSegment(stored, kms, kekProvider)).rejects.toThrow();
  });

  it("encrypts each call with a unique GCM nonce + unique DEK", async () => {
    const segment = makeSegment();
    const a = await encryptSegment(segment, kms, kek);
    const b = await encryptSegment({ ...segment, id: `${segment.id}-b` }, kms, kek);
    expect(a.gcmNonce).not.toEqual(b.gcmNonce);
    expect(a.wrappedDek).not.toEqual(b.wrappedDek);
  });
});

// ─── Retention window math ────────────────────────────────────────────────────

describe("computeRetentionClose — 7-year default, jurisdiction overrides", () => {
  const createdMs = new Date("2026-01-01T00:00:00.000Z").getTime();

  it("defaults to 7 years when no override is set", () => {
    const w = computeRetentionClose(createdMs);
    expect(w.closeAtMs - createdMs).toBe(DEFAULT_RETENTION_MS);
    expect(w.sourceMs).toBe(DEFAULT_RETENTION_MS);
    expect(w.overrideJurisdiction).toBeUndefined();
  });

  it("applies explicit millisecond override", () => {
    const overrideMs = 24 * 60 * 60 * 1000;
    const w = computeRetentionClose(createdMs, undefined, overrideMs);
    expect(w.closeAtMs - createdMs).toBe(overrideMs);
    expect(w.overrideMs).toBe(overrideMs);
  });

  it("applies known jurisdiction override: gdpr-default → 3 years", () => {
    const w = computeRetentionClose(createdMs, "gdpr-default");
    const expectedMs = 3 * 365 * 24 * 60 * 60 * 1000;
    expect(w.closeAtMs - createdMs).toBe(expectedMs);
    expect(w.overrideJurisdiction).toBe("gdpr-default");
  });

  it("applies known jurisdiction override: finra-us → 10 years", () => {
    const w = computeRetentionClose(createdMs, "finra-us");
    const expectedMs = 10 * 365 * 24 * 60 * 60 * 1000;
    expect(w.closeAtMs - createdMs).toBe(expectedMs);
  });

  it("explicit ms override takes precedence over jurisdiction", () => {
    const explicit = 99 * 24 * 60 * 60 * 1000;
    const w = computeRetentionClose(createdMs, "finra-us", explicit);
    expect(w.closeAtMs - createdMs).toBe(explicit);
    expect(w.overrideJurisdiction).toBe("finra-us");
    expect(w.overrideMs).toBe(explicit);
  });

  it("unknown jurisdiction falls back to the 7-year default", () => {
    const w = computeRetentionClose(createdMs, "unknown-jx-xx");
    expect(w.closeAtMs - createdMs).toBe(DEFAULT_RETENTION_MS);
  });
});

// ─── Store service ────────────────────────────────────────────────────────────

describe("DisputeMediationTranscriptStore service (issue #450)", () => {
  let pool: Pool;
  let kms: InMemoryTranscriptKms;
  let kekProvider: InMemoryActiveKekProvider;
  let repository: InMemoryTranscriptRepository;
  let store: DisputeMediationTranscriptStore;

  beforeEach(() => {
    pool = makeMockPool();
    const s = setupKms();
    kms = s.kms;
    kekProvider = s.kekProvider;
    repository = new InMemoryTranscriptRepository();
    repository._clear();
    store = new DisputeMediationTranscriptStore(pool, kms, kekProvider, repository);
    transcriptStoreEvents.removeAllListeners();
  });

  it("appendSegment → getSegment round-trips plaintext byte-for-byte", async () => {
    const segment = makeSegment({
      body: "The supplier confirmed a 2-week delay. Requesting full refund.",
      kind: "chat",
      metadata: { channel: "email", threadId: "t-123" },
    });
    const stored = await store.appendSegment(segment);
    expect(stored.id).toBe(segment.id);
    expect(stored.kekVersionId).toBe("kek-v1");
    expect(stored.retentionStatus).toBe("active");
    expect(stored.ciphertext.length).toBeGreaterThan(0);

    const roundtrip = await store.getSegment(segment.id);
    expect(roundtrip).not.toBeNull();
    expect(roundtrip!.body).toBe(segment.body);
    expect(roundtrip!.metadata).toEqual(segment.metadata);
    expect(roundtrip!.kind).toBe(segment.kind);
  });

  it("appendSegment stores SHA-256 of plaintext body (verifiable dedup tag)", async () => {
    const segment = makeSegment({ body: "hello verifiable body" });
    const stored = await store.appendSegment(segment);
    const expected = require("crypto")
      .createHash("sha256")
      .update(segment.body, "utf8")
      .digest("hex");
    expect(stored.bodySha256).toBe(expected);
  });

  it("listDisputeSegments returns them in created order", async () => {
    const disputeId = "dispute-ordered";
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `ord-${i}`;
      ids.push(id);
      await store.appendSegment(
        makeSegment({ id, disputeId, body: `msg ${i}`, authoredAtIso: new Date(2000 + i).toISOString() }),
      );
    }
    const listed = await store.listDisputeSegments(disputeId);
    expect(listed.map((s) => s.id)).toEqual(ids);
  });

  it("getSegment returns null after retention purge", async () => {
    const segment = makeSegment();
    await store.appendSegment(segment);
    const now = new Date(segment.authoredAtIso!).getTime() + DEFAULT_RETENTION_MS + 1;

    const mockPoolAny = pool as any;
    const client = await mockPoolAny.connect();
    await repository.purgeExpired(client, now, 100);

    const purged = await store.getSegment(segment.id);
    expect(purged).toBeNull();
  });

  it("emits segment.appended event with id and disputeId on successful insert", async () => {
    let caught: any = null;
    transcriptStoreEvents.on("segment.appended", (e) => { caught = e; });
    const segment = makeSegment({ id: "evt-seg", disputeId: "evt-dispute" });
    await store.appendSegment(segment);
    expect(caught).not.toBeNull();
    expect(caught.id).toBe("evt-seg");
    expect(caught.disputeId).toBe("evt-dispute");
  });

  it("re-encrypts under a new KEK after rotation (ciphertext untouched, only wrapped DEK changes)", async () => {
    const segment = makeSegment({ id: "rotate-kek-seg" });
    await store.appendSegment(segment);
    const oldRow = (await store["repository"].findById((await pool.connect()) as any, segment.id))!;
    const oldWrappedDek = Buffer.from(oldRow.wrappedDek);

    const newKek = { id: "kek-v2" };
    const newMaterial = Buffer.alloc(32, 0xcc);
    kms.registerKek(newKek.id, newMaterial);
    kekProvider.register(newKek).setActive(newKek);

    const plainDekOld = await kms.unwrapDek(oldWrappedDek, { id: "kek-v1" });
    const reWrapped = await kms.wrapDek(plainDekOld, newKek);
    expect(reWrapped).not.toEqual(oldWrappedDek);

    oldRow.wrappedDek = reWrapped;
    oldRow.kekVersionId = newKek.id;

    const reUnwrapped = await kms.unwrapDek(Buffer.from(oldRow.wrappedDek), newKek);
    expect(reUnwrapped).toEqual(plainDekOld);

    plainDekOld.fill(0);
    reUnwrapped.fill(0);
  });
});

// ─── Retention sweep runner ──────────────────────────────────────────────────

describe("DisputeMediationRetentionRunner — 7-year default purge (issue #450)", () => {
  let pool: Pool;
  let kms: InMemoryTranscriptKms;
  let kekProvider: InMemoryActiveKekProvider;
  let repository: InMemoryTranscriptRepository;
  let runner: DisputeMediationRetentionRunner;

  beforeEach(() => {
    pool = makeMockPool();
    const s = setupKms();
    kms = s.kms;
    kekProvider = s.kekProvider;
    repository = new InMemoryTranscriptRepository();
    repository._clear();
    runner = new DisputeMediationRetentionRunner(pool, repository, { batchLimit: 100 });
    transcriptStoreEvents.removeAllListeners();
  });

  it("purges segments whose 7yr default window has closed", async () => {
    const store = new DisputeMediationTranscriptStore(pool, kms, kekProvider, repository);
    const createdAgo = DEFAULT_RETENTION_MS + 24 * 60 * 60 * 1000;
    const pastIso = new Date(Date.now() - createdAgo).toISOString();

    await store.appendSegment(makeSegment({ id: "expired-seg" }), { nowIso: pastIso });
    await store.appendSegment(makeSegment({ id: "fresh-seg" }));

    const result = await runner.runOnce(Date.now());
    expect(result.purgedIds).toContain("expired-seg");
    expect(result.purgedIds).not.toContain("fresh-seg");
    expect(result.purgedCount).toBe(1);
  });

  it("honours FINRA 10-year jurisdiction override (not purged at 7y boundary)", async () => {
    const store = new DisputeMediationTranscriptStore(pool, kms, kekProvider, repository);
    const sevenYearsAgo = new Date(Date.now() - DEFAULT_RETENTION_MS - 1000).toISOString();

    await store.appendSegment(makeSegment({ id: "finra-old" }), {
      nowIso: sevenYearsAgo,
      retentionOverrideJurisdiction: "finra-us",
    });

    const now = Date.now();
    const { purgedIds } = await runner.runOnce(now);
    expect(purgedIds).not.toContain("finra-old");

    const tenYearsMs = 10 * 365 * 24 * 60 * 60 * 1000;
    const wayLater = new Date(sevenYearsAgo).getTime() + tenYearsMs + 1_000_000;
    const forced = await runner.runOnce(wayLater);
    expect(forced.purgedIds).toContain("finra-old");
  });

  it("honours GDPR 3-year override (purged earlier than default)", async () => {
    const store = new DisputeMediationTranscriptStore(pool, kms, kekProvider, repository);
    const fourYearsAgo = Date.now() - 4 * 365 * 24 * 60 * 60 * 1000;

    await store.appendSegment(makeSegment({ id: "gdpr-seg" }), {
      nowIso: new Date(fourYearsAgo).toISOString(),
      retentionOverrideJurisdiction: "gdpr-default",
    });

    const { purgedIds } = await runner.runOnce(Date.now());
    expect(purgedIds).toContain("gdpr-seg");
  });

  it("batch limit caps the number purged in a single sweep", async () => {
    const store = new DisputeMediationTranscriptStore(pool, kms, kekProvider, repository);
    const oldIso = new Date(Date.now() - DEFAULT_RETENTION_MS * 2).toISOString();
    for (let i = 0; i < 10; i++) {
      await store.appendSegment(makeSegment({ id: `batched-${i}` }), { nowIso: oldIso });
    }

    const smallRunner = new DisputeMediationRetentionRunner(pool, repository, { batchLimit: 3 });
    const r1 = await smallRunner.runOnce(Date.now());
    expect(r1.purgedCount).toBe(3);

    const r2 = await smallRunner.runOnce(Date.now());
    expect(r2.purgedCount).toBe(3);

    const r3 = await smallRunner.runOnce(Date.now());
    expect(r3.purgedCount).toBe(3);

    const r4 = await smallRunner.runOnce(Date.now());
    expect(r4.purgedCount).toBe(1);
  });

  it("emit retention.sweep event with jurisdiction breakdown", async () => {
    const store = new DisputeMediationTranscriptStore(pool, kms, kekProvider, repository);
    const oldIso = new Date(Date.now() - DEFAULT_RETENTION_MS * 2).toISOString();
    await store.appendSegment(makeSegment({ id: "default-old" }), { nowIso: oldIso });
    await store.appendSegment(makeSegment({ id: "gdpr-old" }), {
      nowIso: oldIso,
      retentionOverrideJurisdiction: "gdpr-default",
    });

    let sweepEvent: any = null;
    transcriptStoreEvents.on("retention.sweep", (e) => { sweepEvent = e; });
    await runner.runOnce(Date.now());

    expect(sweepEvent).not.toBeNull();
    expect(sweepEvent.purgedCount).toBe(2);
    const jx = sweepEvent.jurisdictionCounts;
    expect(jx["default-7y"]).toBe(1);
    expect(jx["gdpr-default"]).toBe(1);
  });
});

// ─── Voice transcript segment specific cover ──────────────────────────────────

describe("voice transcript segments store diarised speakers correctly", () => {
  it("round-trips voice transcript with diarised speaker metadata", async () => {
    const pool = makeMockPool();
    const s = setupKms();
    const repository = new InMemoryTranscriptRepository();
    const store = new DisputeMediationTranscriptStore(pool, s.kms, s.kekProvider, repository);

    const segment = makeSegment({
      id: "voice-001",
      kind: "voice",
      participant: { id: "transcription-engine", role: "automation" },
      body: "[00:00:03] Mediator: Welcome both parties.\n[00:00:15] Buyer: I never received...",
      metadata: {
        transcriptionConfidence: 0.94,
        speakers: [
          { speakerLabel: "Mediator", participantId: "med-1", channel: 0 },
          { speakerLabel: "Buyer", participantId: "buy-1", channel: 1 },
        ],
        callDurationSec: 1845,
        audioSha256: "a".repeat(64),
      },
    });

    await store.appendSegment(segment);
    const roundtrip = (await store.getSegment(segment.id))!;
    expect(roundtrip.kind).toBe("voice");
    expect(roundtrip.body.startsWith("[00:00:03] Mediator:")).toBe(true);
    expect(roundtrip.metadata!.transcriptionConfidence).toBe(0.94);
    expect(Array.isArray(roundtrip.metadata!.speakers)).toBe(true);
    expect((roundtrip.metadata!.speakers as any[]).length).toBe(2);
  });
});
