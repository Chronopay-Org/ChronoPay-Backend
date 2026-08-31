import crypto from "crypto";

/**
 * MFA secret encryption at rest.
 *
 * The raw TOTP secret is stored AES-256-GCM encrypted. Rather than sharing a
 * single key across every user, a **per-user key** is derived from a master
 * key via HKDF-SHA256 with a random per-enrollment salt (documented as
 * "per-user key derivation" in issue #809). A random salt also means the same
 * master key never yields the same user key twice, bounding ciphertext reuse.
 *
 * Format contract (hex-encoded base64 fields are stored separately in the
 * `mfa_enrollments` table so the row is self-describing):
 *   - ciphertext = AES-256-GCM(plaintextSecret, key=hkdf, iv=<12B random>)
 *   - authTag     = GCM auth tag (16B)
 *
 * The master key is provisioned via `MFA_ENCRYPTION_KEY` (32-byte hex or
 * base64, see env.ts). It never touches the database.
 */

export const MFA_ENCRYPTION_INFO = "chronopay-mfa-totp-secret";
export const MFA_GCM_IV_BYTES = 12;
export const MFA_GCM_TAG_BYTES = 16;
export const MFA_KDF_SALT_BYTES = 16;
export const MFA_GCM_AAD = Buffer.from("chronopay-mfa-enrollment/v1", "ascii");

export interface EncryptedSecretMaterial {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  salt: Buffer;
}

export interface MfaEncryptionKeys {
  /** Master key from the secrets provider (hex or base64 encoded). */
  masterKey: string;
}

/** Validates and normalises the master key into the raw 32-byte AES key. */
export function deriveMasterKey(masterKeyHexOrB64: string): Buffer {
  const candidate = masterKeyHexOrB64.trim();
  // Prefer base64 when it decodes to exactly 32 bytes; otherwise hex.
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(candidate)) {
    const fromBase64 = Buffer.from(candidate, "base64");
    if (fromBase64.length === 32) return fromBase64;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(candidate)) {
    throw new Error("MFA_ENCRYPTION_KEY must be a 32-byte key encoded as 64 hex chars or base64");
  }
  return Buffer.from(candidate, "hex");
}

/**
 * Derives the per-user (per-enrollment) AES key from the master key and salt.
 * Deterministic: same master key + same salt always yield the same user key,
 * which is what allows decrypting later verifications.
 */
export function derivePerUserKey(masterKey: Buffer, salt: Buffer): Buffer {
  if (salt.length < 8) {
    throw new Error("MFA KDF salt must be at least 8 bytes");
  }
  // hkdfSync returns an ArrayBuffer; normalise to Buffer so callers can rely
  // on the full Buffer API regardless of Node version.
  return Buffer.from(crypto.hkdfSync("sha256", masterKey, salt, MFA_ENCRYPTION_INFO, 32));
}

/** Encrypts a raw TOTP secret with a freshly derived per-user AES-256-GCM key. */
export function encryptTotpSecret(secret: Buffer, keys: MfaEncryptionKeys): EncryptedSecretMaterial {
  const masterKey = deriveMasterKey(keys.masterKey);
  const salt = crypto.randomBytes(MFA_KDF_SALT_BYTES);
  const iv = crypto.randomBytes(MFA_GCM_IV_BYTES);
  const userKey = derivePerUserKey(masterKey, salt);

  const cipher = crypto.createCipheriv("aes-256-gcm", userKey, iv);
  cipher.setAAD(MFA_GCM_AAD);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return { ciphertext, iv, authTag, salt };
}

/**
 * Decrypts an encrypted TOTP secret. Throws on any tampering (bad tag,
 * short fields, wrong key) so a corrupted row fails closed.
 */
export function decryptTotpSecret(
  material: EncryptedSecretMaterial,
  keys: MfaEncryptionKeys,
): Buffer {
  const masterKey = deriveMasterKey(keys.masterKey);

  if (material.iv.length !== MFA_GCM_IV_BYTES || material.authTag.length !== MFA_GCM_TAG_BYTES) {
    throw new Error("Encrypted MFA secret has invalid iv or auth tag length");
  }
  if (material.salt.length < 8) {
    throw new Error("Encrypted MFA secret has invalid KDF salt");
  }

  const userKey = derivePerUserKey(masterKey, material.salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", userKey, material.iv);
  decipher.setAAD(MFA_GCM_AAD);
  decipher.setAuthTag(material.authTag);

  const plaintext = Buffer.concat([decipher.update(material.ciphertext), decipher.final()]);
  return plaintext;
}