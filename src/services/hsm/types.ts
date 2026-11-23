/**
 * HSM Adapter — shared types and error classes.
 *
 * All concrete adapters (AWS KMS, GCP Cloud KMS, …) operate on these types,
 * giving callers a single, provider-agnostic surface.
 */

// ---------------------------------------------------------------------------
// Value objects
// ---------------------------------------------------------------------------

/**
 * Identifies a cryptographic key inside a KMS provider.
 *
 * - AWS  : keyId is the full Key ARN or alias ARN
 * - GCP  : keyId is the full resource name:
 *          `projects/{p}/locations/{l}/keyRings/{kr}/cryptoKeys/{ck}/cryptoKeyVersions/{v}`
 *          (or the key ring path for auto-versioning)
 * - Both : keyId can optionally carry a human-readable `alias`
 */
export interface HsmKeyRef {
  /** Provider-native key identifier (ARN, GCP resource name, …). */
  keyId: string;
  /** Optional human-readable alias — used only for logging / error messages. */
  alias?: string;
}

/**
 * Algorithm used for the signing operation.
 *
 * - AWS  : maps to the `SigningAlgorithmSpec`
 * - GCP  : maps to the `CryptoKeyVersion`'s algorithm field
 *
 * Only asymmetric signing algorithms meaningful to an HSM are listed.
 * Symmetric HMAC variants are *not* included because they cannot be verified
 * externally without sharing the key material.
 */
export type SigningAlgorithm =
  | "RSASSA_PSS_SHA_256"
  | "RSASSA_PSS_SHA_384"
  | "RSASSA_PSS_SHA_512"
  | "RSASSA_PKCS1_V1_5_SHA_256"
  | "RSASSA_PKCS1_V1_5_SHA_384"
  | "RSASSA_PKCS1_V1_5_SHA_512"
  | "ECDSA_SHA_256"
  | "ECDSA_SHA_384"
  | "ECDSA_SHA_512";

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

export interface SignRequest {
  /** Key to sign with. */
  key: HsmKeyRef;
  /** Raw message bytes to sign (pre-hashed or raw, depending on the algorithm). */
  message: Uint8Array;
  /** Algorithm to use; must match the key's configured purpose. */
  algorithm: SigningAlgorithm;
}

export interface SignResponse {
  /** DER-encoded signature bytes returned by the KMS. */
  signature: Uint8Array;
  /** Algorithm that was used (echoed from the request / confirmed by provider). */
  algorithm: SigningAlgorithm;
  /** Opaque version identifier for the key that produced this signature. */
  keyVersion: string;
}

export interface VerifyRequest {
  /** Key to verify with. */
  key: HsmKeyRef;
  /** The original message bytes that were signed. */
  message: Uint8Array;
  /** Signature to verify (DER-encoded bytes). */
  signature: Uint8Array;
  /** Algorithm that was used when signing. */
  algorithm: SigningAlgorithm;
}

export interface VerifyResponse {
  /** `true` if the signature is valid; `false` otherwise. */
  valid: boolean;
  /** Opaque key version identifier used for verification. */
  keyVersion: string;
}

export interface RotateRequest {
  /** Key whose primary version should be rotated. */
  key: HsmKeyRef;
}

export interface RotateResponse {
  /** New primary key version identifier after rotation. */
  newKeyVersion: string;
  /** Previous primary key version identifier (now disabled / scheduled for deletion). */
  previousKeyVersion: string;
}

// ---------------------------------------------------------------------------
// Discriminated error types
// ---------------------------------------------------------------------------

export type HsmErrorCode =
  | "KEY_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "INVALID_SIGNATURE"
  | "ALGORITHM_MISMATCH"
  | "KEY_DISABLED"
  | "REGION_UNAVAILABLE"
  | "PROVIDER_ERROR"
  | "UNKNOWN";

export class HsmError extends Error {
  public readonly code: HsmErrorCode;
  public readonly keyRef?: HsmKeyRef;
  public readonly cause?: Error;

  constructor(
    message: string,
    code: HsmErrorCode,
    options?: { keyRef?: HsmKeyRef; cause?: Error },
  ) {
    super(message);
    this.name = "HsmError";
    this.code = code;
    this.keyRef = options?.keyRef;
    this.cause = options?.cause;
  }
}
