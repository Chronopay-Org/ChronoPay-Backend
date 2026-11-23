/**
 * RevocationService
 *
 * Broadcasts signing-key revocations to all replicas in under 60 seconds via
 * Redis pub/sub, enforces revocations locally in-memory, and sends per-replica
 * acknowledgements back through a dedicated ack channel.
 *
 * Design
 * ──────
 * - A **publisher** Redis connection is used for PUBLISH commands.
 * - A **subscriber** Redis connection is dedicated to SUBSCRIBE (ioredis
 *   moves a connection into subscriber mode on the first subscribe() call,
 *   after which it can't issue regular commands).
 * - Revoked key IDs are stored in an in-memory `Set` so `isRevoked()` is
 *   O(1) and never hits Redis on the hot path.
 * - On receiving a revocation message this replica:
 *     1. Adds the key ID to the local revoked set.
 *     2. Emits the `revoked` event (for internal listeners).
 *     3. Publishes an ack to the ack channel.
 * - The service is intentionally decoupled from HTTP — it can be started once
 *   at app boot and shared across middleware.
 *
 * Channel protocol
 * ────────────────
 * Broadcast channel : `revoke:signing-keys`
 * Payload           : JSON – RevocationMessage
 *
 * Ack channel       : `revoke:signing-keys:ack`
 * Payload           : JSON – RevocationAck
 *
 * Both channels use the same JSON envelope for forward-compatibility.
 */

import EventEmitter from "events";
import { createRequire } from "module";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RevocationMessage {
  /** The signing key ID being revoked. */
  keyId: string;
  /** ISO-8601 timestamp when the revocation was initiated. */
  revokedAt: string;
  /** Arbitrary reason code (e.g. "COMPROMISED", "EXPIRED"). */
  reason?: string;
}

export interface RevocationAck {
  keyId: string;
  replicaId: string;
  ackedAt: string;
}

/**
 * Minimal Redis surface required by RevocationService.
 * The publisher needs publish; the subscriber needs subscribe/on.
 * Tests inject fakes that satisfy this interface.
 */
export interface RevocationPublisher {
  publish(channel: string, message: string): Promise<number>;
}

export interface RevocationSubscriber {
  subscribe(channel: string): Promise<unknown>;
  on(event: "message", handler: (channel: string, message: string) => void): this;
  on(event: string, handler: (...args: unknown[]) => void): this;
}

export interface RevocationServiceOptions {
  /** Identifies this replica in ack payloads. */
  replicaId: string;
  /** Redis client used for publishing (regular commands). */
  publisher: RevocationPublisher;
  /** Redis client used for subscribing (subscriber mode). */
  subscriber: RevocationSubscriber;
  /** Pub/sub channel name. Defaults to "revoke:signing-keys". */
  broadcastChannel?: string;
  /** Ack channel name. Defaults to "revoke:signing-keys:ack". */
  ackChannel?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const REVOCATION_CHANNEL = "revoke:signing-keys";
export const ACK_CHANNEL = "revoke:signing-keys:ack";

// ─── Service ─────────────────────────────────────────────────────────────────

export class RevocationService extends EventEmitter {
  private readonly replicaId: string;
  private readonly publisher: RevocationPublisher;
  private readonly subscriber: RevocationSubscriber;
  private readonly broadcastChannel: string;
  private readonly ackChannel: string;

  /** In-memory set of revoked key IDs. Hot-path lookup is O(1). */
  private readonly revokedKeys = new Set<string>();

  private subscribed = false;

  constructor(opts: RevocationServiceOptions) {
    super();
    this.replicaId = opts.replicaId;
    this.publisher = opts.publisher;
    this.subscriber = opts.subscriber;
    this.broadcastChannel = opts.broadcastChannel ?? REVOCATION_CHANNEL;
    this.ackChannel = opts.ackChannel ?? ACK_CHANNEL;
  }

  /**
   * Attach the message listener and subscribe to the broadcast channel.
   * Call once at startup. Safe to call multiple times (idempotent).
   */
  async start(): Promise<void> {
    if (this.subscribed) return;
    this.subscribed = true;

    this.subscriber.on("message", (channel, message) => {
      if (channel !== this.broadcastChannel) return;
      this._handleMessage(message);
    });

    await this.subscriber.subscribe(this.broadcastChannel);
  }

  /**
   * Broadcast a revocation to all replicas.
   *
   * @param keyId   The signing key ID to revoke.
   * @param reason  Optional human-readable reason.
   */
  async revoke(keyId: string, reason?: string): Promise<void> {
    if (!keyId || keyId.trim().length === 0) {
      throw new Error("keyId must be a non-empty string");
    }

    const message: RevocationMessage = {
      keyId: keyId.trim(),
      revokedAt: new Date().toISOString(),
      reason,
    };

    await this.publisher.publish(this.broadcastChannel, JSON.stringify(message));
  }

  /**
   * Returns true if the given key ID has been revoked on this replica.
   * O(1) — never hits Redis.
   */
  isRevoked(keyId: string): boolean {
    return this.revokedKeys.has(keyId);
  }

  /**
   * Expose the current revoked key IDs (read-only snapshot).
   * Useful for diagnostics and health checks.
   */
  getRevokedKeys(): ReadonlySet<string> {
    return this.revokedKeys;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private _handleMessage(raw: string): void {
    let msg: RevocationMessage;

    try {
      msg = JSON.parse(raw) as RevocationMessage;
    } catch {
      this.emit("error", new Error(`RevocationService: malformed message: ${raw}`));
      return;
    }

    if (!msg.keyId || typeof msg.keyId !== "string") {
      this.emit("error", new Error(`RevocationService: missing keyId in message: ${raw}`));
      return;
    }

    const keyId = msg.keyId.trim();
    if (keyId.length === 0) {
      this.emit("error", new Error(`RevocationService: empty keyId in message`));
      return;
    }

    // 1. Enforce locally.
    this.revokedKeys.add(keyId);

    // 2. Notify internal listeners.
    this.emit("revoked", msg);

    // 3. Acknowledge back on the ack channel (fire-and-forget).
    const ack: RevocationAck = {
      keyId,
      replicaId: this.replicaId,
      ackedAt: new Date().toISOString(),
    };
    this.publisher.publish(this.ackChannel, JSON.stringify(ack)).catch((err: unknown) => {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a RevocationService backed by two dedicated ioredis connections
 * (one publisher, one subscriber).  Should be called once at app startup.
 *
 * Only used in production — tests inject fakes via the constructor.
 */
export function createRevocationService(
  replicaId: string,
  redisUrl: string,
): RevocationService {
  const require = createRequire(import.meta.url);
  const { Redis } = require("ioredis") as {
    Redis: new (url: string) => RevocationPublisher & RevocationSubscriber;
  };

  const publisher = new Redis(redisUrl);
  const subscriber = new Redis(redisUrl);

  return new RevocationService({ replicaId, publisher, subscriber });
}
