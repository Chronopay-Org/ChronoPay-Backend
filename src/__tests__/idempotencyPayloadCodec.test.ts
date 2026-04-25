import {
  createIdempotencyPayloadCodec,
  IdempotencyPayloadDecryptError,
} from "../utils/idempotencyPayloadCodec.js";
import type { IdempotencyRedisEncryptionConfig } from "../config/env.js";

const PRIMARY_KEY = Buffer.alloc(32, 7);
const PREVIOUS_KEY = Buffer.alloc(32, 8);

function makeDisabledConfig(): IdempotencyRedisEncryptionConfig {
  return {
    enabled: false,
    algorithm: "aes-256-gcm",
    activeKey: null,
    decryptionKeys: [],
  };
}

function makeEnabledConfig(): IdempotencyRedisEncryptionConfig {
  const activeKey = {
    id: "primary-2026-04",
    value: PRIMARY_KEY,
  };

  return {
    enabled: true,
    algorithm: "aes-256-gcm",
    activeKey,
    decryptionKeys: [activeKey],
  };
}

describe("IdempotencyPayloadCodec", () => {
  it("returns plaintext JSON when encryption is disabled", () => {
    const codec = createIdempotencyPayloadCodec(makeDisabledConfig());
    const payload = { status: "completed", responseBody: { ok: true } };

    const stored = codec.serialize(payload);

    expect(stored).toBe(JSON.stringify(payload));
    expect(codec.deserialize<typeof payload>(stored)).toEqual(payload);
  });

  it("encrypts and decrypts payloads with AEAD when encryption is enabled", () => {
    const codec = createIdempotencyPayloadCodec(makeEnabledConfig());
    const payload = { status: "completed", responseBody: { secret: "value" } };

    const stored = codec.serialize(payload);

    expect(stored).toContain("\"enc\"");
    expect(stored).not.toContain("secret");
    expect(codec.deserialize<typeof payload>(stored)).toEqual(payload);
  });

  it("supports rotation by decrypting with a previous key while encrypting with the active key", () => {
    const previousConfig: IdempotencyRedisEncryptionConfig = {
      enabled: true,
      algorithm: "aes-256-gcm",
      activeKey: {
        id: "previous-2026-03",
        value: PREVIOUS_KEY,
      },
      decryptionKeys: [
        {
          id: "previous-2026-03",
          value: PREVIOUS_KEY,
        },
      ],
    };
    const rotatedConfig: IdempotencyRedisEncryptionConfig = {
      enabled: true,
      algorithm: "aes-256-gcm",
      activeKey: {
        id: "primary-2026-04",
        value: PRIMARY_KEY,
      },
      decryptionKeys: [
        {
          id: "primary-2026-04",
          value: PRIMARY_KEY,
        },
        {
          id: "previous-2026-03",
          value: PREVIOUS_KEY,
        },
      ],
    };
    const payload = { status: "completed", requestHash: "abc123" };

    const oldCiphertext = createIdempotencyPayloadCodec(previousConfig).serialize(payload);
    const rotatedCodec = createIdempotencyPayloadCodec(rotatedConfig);

    expect(rotatedCodec.deserialize<typeof payload>(oldCiphertext)).toEqual(payload);
    expect(rotatedCodec.serialize(payload)).toContain("primary-2026-04");
  });

  it("keeps backward compatibility with plaintext payloads during rollout", () => {
    const codec = createIdempotencyPayloadCodec(makeEnabledConfig());
    const plaintext = JSON.stringify({
      status: "completed",
      requestHash: "abc123",
      statusCode: 201,
      responseBody: { success: true },
    });

    expect(codec.deserialize(plaintext)).toEqual(JSON.parse(plaintext));
  });

  it("returns non-object JSON values unchanged when they are not encrypted envelopes", () => {
    const codec = createIdempotencyPayloadCodec(makeEnabledConfig());

    expect(codec.deserialize("\"plain-string\"")).toBe("plain-string");
  });

  it("throws when ciphertext cannot be decrypted with configured keys", () => {
    const encrypted = createIdempotencyPayloadCodec(makeEnabledConfig()).serialize({
      status: "completed",
      requestHash: "abc123",
    });
    const wrongKeyConfig: IdempotencyRedisEncryptionConfig = {
      enabled: true,
      algorithm: "aes-256-gcm",
      activeKey: {
        id: "other-2026-05",
        value: Buffer.alloc(32, 9),
      },
      decryptionKeys: [
        {
          id: "other-2026-05",
          value: Buffer.alloc(32, 9),
        },
      ],
    };

    expect(() =>
      createIdempotencyPayloadCodec(wrongKeyConfig).deserialize(encrypted),
    ).toThrow(IdempotencyPayloadDecryptError);
  });

  it("throws when the key id matches but authentication fails", () => {
    const encrypted = createIdempotencyPayloadCodec(makeEnabledConfig()).serialize({
      status: "completed",
      requestHash: "abc123",
    });
    const wrongBytesSameKeyId: IdempotencyRedisEncryptionConfig = {
      enabled: true,
      algorithm: "aes-256-gcm",
      activeKey: {
        id: "primary-2026-04",
        value: Buffer.alloc(32, 10),
      },
      decryptionKeys: [
        {
          id: "primary-2026-04",
          value: Buffer.alloc(32, 10),
        },
      ],
    };

    expect(() =>
      createIdempotencyPayloadCodec(wrongBytesSameKeyId).deserialize(encrypted),
    ).toThrow(new IdempotencyPayloadDecryptError("Failed to decrypt idempotency payload."));
  });
});
