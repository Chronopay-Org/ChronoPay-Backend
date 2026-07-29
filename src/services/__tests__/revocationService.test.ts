/**
 * Tests for RevocationService
 *
 * Covers:
 * - Happy-path broadcast and local enforcement
 * - Ack published on receive
 * - Idempotent start()
 * - revoke() validation (empty keyId)
 * - Malformed message handling
 * - Missing keyId field
 * - Unknown / never-seen key treated as not-revoked
 * - getRevokedKeys() snapshot
 * - Publisher error surfaced via 'error' event
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import EventEmitter from "events";
import {
  RevocationService,
  REVOCATION_CHANNEL,
  ACK_CHANNEL,
  type RevocationMessage,
  type RevocationAck,
  type RevocationPublisher,
  type RevocationSubscriber,
} from "../revocationService.js";

// ─── Fake pub/sub helpers ────────────────────────────────────────────────────

/**
 * FakeRedis acts as both publisher and subscriber.
 * Calling subscribe() records the channel; calling simulateMessage() fires
 * the registered "message" listeners synchronously.
 */
class FakeRedis extends EventEmitter implements RevocationPublisher, RevocationSubscriber {
  publishedMessages: Array<{ channel: string; message: string }> = [];
  publishError: Error | null = null;

  async publish(channel: string, message: string): Promise<number> {
    if (this.publishError) throw this.publishError;
    this.publishedMessages.push({ channel, message });
    return 1;
  }

  async subscribe(_channel: string): Promise<unknown> {
    return 1;
  }

  /** Simulate an inbound pub/sub message arriving on this connection. */
  simulateMessage(channel: string, message: string): void {
    this.emit("message", channel, message);
  }
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

function makeService(replicaId = "replica-1") {
  const fake = new FakeRedis();
  const service = new RevocationService({
    replicaId,
    publisher: fake,
    subscriber: fake,
  });
  return { service, fake };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("RevocationService — start() and subscribe", () => {
  it("subscribes to the default broadcast channel", async () => {
    const { fake, service } = makeService();
    const subscribeSpy = jest.spyOn(fake, "subscribe");
    await service.start();
    expect(subscribeSpy).toHaveBeenCalledWith(REVOCATION_CHANNEL);
  });

  it("start() is idempotent — subscribes only once", async () => {
    const { fake, service } = makeService();
    const subscribeSpy = jest.spyOn(fake, "subscribe");
    await service.start();
    await service.start();
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("RevocationService — revoke() broadcast", () => {
  it("publishes to the broadcast channel", async () => {
    const { fake, service } = makeService();
    await service.start();
    await service.revoke("key-abc");
    expect(fake.publishedMessages).toHaveLength(1);
    expect(fake.publishedMessages[0].channel).toBe(REVOCATION_CHANNEL);
  });

  it("published payload contains keyId and revokedAt", async () => {
    const { fake, service } = makeService();
    await service.start();
    const before = Date.now();
    await service.revoke("key-xyz", "COMPROMISED");
    const msg: RevocationMessage = JSON.parse(fake.publishedMessages[0].message);
    expect(msg.keyId).toBe("key-xyz");
    expect(msg.reason).toBe("COMPROMISED");
    expect(new Date(msg.revokedAt).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("trims whitespace from keyId before publishing", async () => {
    const { fake, service } = makeService();
    await service.start();
    await service.revoke("  key-trim  ");
    const msg: RevocationMessage = JSON.parse(fake.publishedMessages[0].message);
    expect(msg.keyId).toBe("key-trim");
  });

  it("throws on empty keyId", async () => {
    const { service } = makeService();
    await service.start();
    await expect(service.revoke("")).rejects.toThrow("keyId must be a non-empty string");
  });

  it("throws on whitespace-only keyId", async () => {
    const { service } = makeService();
    await service.start();
    await expect(service.revoke("   ")).rejects.toThrow("keyId must be a non-empty string");
  });
});

describe("RevocationService — receive and enforce", () => {
  it("marks key as revoked on receiving a valid message", async () => {
    const { fake, service } = makeService();
    await service.start();

    const msg: RevocationMessage = { keyId: "key-1", revokedAt: new Date().toISOString() };
    fake.simulateMessage(REVOCATION_CHANNEL, JSON.stringify(msg));

    expect(service.isRevoked("key-1")).toBe(true);
  });

  it("emits 'revoked' event with the parsed message", async () => {
    const { fake, service } = makeService();
    await service.start();

    const received: RevocationMessage[] = [];
    service.on("revoked", (m: RevocationMessage) => received.push(m));

    const msg: RevocationMessage = { keyId: "key-2", revokedAt: new Date().toISOString() };
    fake.simulateMessage(REVOCATION_CHANNEL, JSON.stringify(msg));

    expect(received).toHaveLength(1);
    expect(received[0].keyId).toBe("key-2");
  });

  it("publishes an ack on the ack channel", async () => {
    const { fake, service } = makeService("replica-A");
    await service.start();

    const msg: RevocationMessage = { keyId: "key-3", revokedAt: new Date().toISOString() };
    fake.simulateMessage(REVOCATION_CHANNEL, JSON.stringify(msg));

    // The ack publish is fire-and-forget; flush micro-task queue
    await Promise.resolve();

    const ackPub = fake.publishedMessages.find((p) => p.channel === ACK_CHANNEL);
    expect(ackPub).toBeDefined();
    const ack: RevocationAck = JSON.parse(ackPub!.message);
    expect(ack.keyId).toBe("key-3");
    expect(ack.replicaId).toBe("replica-A");
    expect(typeof ack.ackedAt).toBe("string");
  });

  it("ignores messages on unrelated channels", async () => {
    const { fake, service } = makeService();
    await service.start();

    fake.simulateMessage("other:channel", JSON.stringify({ keyId: "key-x", revokedAt: "" }));
    expect(service.isRevoked("key-x")).toBe(false);
  });

  it("unknown key (never-seen) is not revoked", async () => {
    const { service } = makeService();
    await service.start();
    expect(service.isRevoked("no-such-key")).toBe(false);
  });
});

describe("RevocationService — malformed messages", () => {
  it("emits 'error' on non-JSON payload", async () => {
    const { fake, service } = makeService();
    await service.start();

    const errors: Error[] = [];
    service.on("error", (e: Error) => errors.push(e));

    fake.simulateMessage(REVOCATION_CHANNEL, "NOT_JSON{{");

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("malformed message");
  });

  it("emits 'error' when keyId is missing", async () => {
    const { fake, service } = makeService();
    await service.start();

    const errors: Error[] = [];
    service.on("error", (e: Error) => errors.push(e));

    fake.simulateMessage(REVOCATION_CHANNEL, JSON.stringify({ revokedAt: new Date().toISOString() }));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("missing keyId");
  });

  it("emits 'error' when keyId is empty string", async () => {
    const { fake, service } = makeService();
    await service.start();

    const errors: Error[] = [];
    service.on("error", (e: Error) => errors.push(e));

    fake.simulateMessage(REVOCATION_CHANNEL, JSON.stringify({ keyId: "  ", revokedAt: "" }));

    expect(errors).toHaveLength(1);
  });

  it("does not revoke anything when message is malformed", async () => {
    const { fake, service } = makeService();
    await service.start();
    service.on("error", () => {}); // swallow

    fake.simulateMessage(REVOCATION_CHANNEL, "GARBAGE");
    expect(service.getRevokedKeys().size).toBe(0);
  });
});

describe("RevocationService — ack publish failure", () => {
  it("emits 'error' when ack publish throws", async () => {
    const { fake, service } = makeService();
    await service.start();

    const errors: Error[] = [];
    service.on("error", (e: Error) => errors.push(e));

    fake.publishError = new Error("Redis disconnected");

    const msg: RevocationMessage = { keyId: "key-fail", revokedAt: new Date().toISOString() };
    fake.simulateMessage(REVOCATION_CHANNEL, JSON.stringify(msg));

    await Promise.resolve(); // flush async ack publish

    // Key should still be revoked locally even if ack fails
    expect(service.isRevoked("key-fail")).toBe(true);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});

describe("RevocationService — getRevokedKeys()", () => {
  it("returns a snapshot of all revoked key IDs", async () => {
    const { fake, service } = makeService();
    await service.start();

    for (const id of ["k1", "k2", "k3"]) {
      const msg: RevocationMessage = { keyId: id, revokedAt: new Date().toISOString() };
      fake.simulateMessage(REVOCATION_CHANNEL, JSON.stringify(msg));
    }

    const snapshot = service.getRevokedKeys();
    expect(snapshot.size).toBe(3);
    expect(snapshot.has("k1")).toBe(true);
    expect(snapshot.has("k2")).toBe(true);
    expect(snapshot.has("k3")).toBe(true);
  });

  it("same key revoked twice is stored once", async () => {
    const { fake, service } = makeService();
    await service.start();

    const msg: RevocationMessage = { keyId: "dup", revokedAt: new Date().toISOString() };
    fake.simulateMessage(REVOCATION_CHANNEL, JSON.stringify(msg));
    fake.simulateMessage(REVOCATION_CHANNEL, JSON.stringify(msg));

    expect(service.getRevokedKeys().size).toBe(1);
  });
});
