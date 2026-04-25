import crypto from "crypto";
import {
  type EnvConfig,
  type IdempotencyRedisEncryptionConfig,
  loadEnvConfig,
} from "../config/env.js";

const ENCRYPTION_CONTEXT = "chronopay:idempotency:redis-payload:v1";
const NONCE_BYTES = 12;
const ENCRYPTION_VERSION = "v1";
const ENCRYPTION_PREFIX = "enc";

interface EncryptedPayloadEnvelope {
  version: typeof ENCRYPTION_VERSION;
  algorithm: "aes-256-gcm";
  keyId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export class IdempotencyPayloadDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyPayloadDecryptError";
  }
}

export class IdempotencyPayloadCodec {
  constructor(private readonly config: IdempotencyRedisEncryptionConfig) {}

  serialize(value: unknown): string {
    const plaintext = JSON.stringify(value);

    if (!this.config.enabled) {
      return plaintext;
    }

    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv(
      this.config.algorithm,
      this.config.activeKey.value,
      nonce,
    );

    cipher.setAAD(Buffer.from(ENCRYPTION_CONTEXT, "utf8"));

    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    const envelope: EncryptedPayloadEnvelope = {
      version: ENCRYPTION_VERSION,
      algorithm: this.config.algorithm,
      keyId: this.config.activeKey.id,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: tag.toString("base64"),
    };

    return JSON.stringify({
      [ENCRYPTION_PREFIX]: envelope,
    });
  }

  deserialize<T>(rawValue: string): T {
    const parsed = JSON.parse(rawValue) as T | { enc?: EncryptedPayloadEnvelope };

    if (!isEncryptedEnvelope(parsed)) {
      return parsed as T;
    }

    const envelope = parsed.enc;
    const key = this.config.decryptionKeys.find((candidate) => candidate.id === envelope.keyId);

    if (!key) {
      throw new IdempotencyPayloadDecryptError(
        `Unable to decrypt idempotency payload for key id '${envelope.keyId}'.`,
      );
    }

    try {
      const decipher = crypto.createDecipheriv(
        envelope.algorithm,
        key.value,
        Buffer.from(envelope.nonce, "base64"),
      );
      decipher.setAAD(Buffer.from(ENCRYPTION_CONTEXT, "utf8"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));

      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");

      return JSON.parse(plaintext) as T;
    } catch {
      throw new IdempotencyPayloadDecryptError("Failed to decrypt idempotency payload.");
    }
  }
}

let configOverride: EnvConfig["idempotencyRedisEncryption"] | null = null;

export function createIdempotencyPayloadCodec(
  config: IdempotencyRedisEncryptionConfig,
): IdempotencyPayloadCodec {
  return new IdempotencyPayloadCodec(config);
}

export function getIdempotencyPayloadCodec(): IdempotencyPayloadCodec {
  if (configOverride) {
    return new IdempotencyPayloadCodec(configOverride);
  }

  const config = loadEnvConfig(process.env).idempotencyRedisEncryption;
  return new IdempotencyPayloadCodec(config);
}

export function setIdempotencyEncryptionConfigForTests(
  config: EnvConfig["idempotencyRedisEncryption"] | null,
): void {
  configOverride = config;
}

function isEncryptedEnvelope(
  value: unknown,
): value is { enc: EncryptedPayloadEnvelope } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = (value as { enc?: Partial<EncryptedPayloadEnvelope> }).enc;
  return Boolean(
    candidate &&
      candidate.version === ENCRYPTION_VERSION &&
      candidate.algorithm === "aes-256-gcm" &&
      typeof candidate.keyId === "string" &&
      typeof candidate.nonce === "string" &&
      typeof candidate.ciphertext === "string" &&
      typeof candidate.tag === "string",
  );
}
