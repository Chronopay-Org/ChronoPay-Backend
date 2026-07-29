/**
 * IHsmAdapter — the provider-agnostic interface every HSM backend must satisfy.
 *
 * Concrete implementations live next to this file:
 *   - AwsKmsAdapter  (aws-kms-adapter.ts)
 *   - GcpKmsAdapter  (gcp-kms-adapter.ts)
 *
 * Design decisions
 * ─────────────────
 * 1.  All operations are async and return typed results rather than throwing
 *     on the happy-path; callers get deterministic shapes.
 * 2.  Errors always surface as `HsmError` with a structured `code`; see
 *     types.ts for the taxonomy.
 * 3.  The interface carries no provider-specific types (no AWS SDK / GCP SDK
 *     imports) so it can be depended on from any module without coupling it
 *     to a specific cloud SDK.
 * 4.  `rotate` deliberately exposes only a *logical* rotation trigger; the
 *     adapter maps that to whatever the provider's native rotation mechanism
 *     is (AWS: CreateKeyRotation / ScheduleKeyDeletion, GCP: CreateCryptoKeyVersion).
 */

import type {
  SignRequest,
  SignResponse,
  VerifyRequest,
  VerifyResponse,
  RotateRequest,
  RotateResponse,
} from "./types.js";

export interface IHsmAdapter {
  /**
   * Sign `message` using the referenced HSM-backed key.
   *
   * @throws {HsmError} with code KEY_NOT_FOUND if the key does not exist.
   * @throws {HsmError} with code PERMISSION_DENIED if credentials are insufficient.
   * @throws {HsmError} with code ALGORITHM_MISMATCH if the algorithm is not
   *                    supported by the key's configured purpose.
   * @throws {HsmError} with code REGION_UNAVAILABLE if the provider endpoint
   *                    is unreachable (after retries).
   */
  sign(request: SignRequest): Promise<SignResponse>;

  /**
   * Verify a signature produced by `sign`.
   *
   * Returns a `VerifyResponse` with `valid: false` for an invalid signature
   * rather than throwing, so callers can distinguish *invalid* from *error*.
   *
   * @throws {HsmError} with code KEY_NOT_FOUND if the key does not exist.
   * @throws {HsmError} with code PERMISSION_DENIED if credentials are insufficient.
   */
  verify(request: VerifyRequest): Promise<VerifyResponse>;

  /**
   * Trigger a key rotation: create a new key version and, where supported,
   * schedule the previous version for destruction.
   *
   * The adapter ensures that:
   * - The new version is immediately usable for signing.
   * - The previous version remains usable for verification until its
   *   scheduled deletion date.
   *
   * @throws {HsmError} with code KEY_NOT_FOUND if the key does not exist.
   * @throws {HsmError} with code PERMISSION_DENIED if credentials are insufficient.
   */
  rotate(request: RotateRequest): Promise<RotateResponse>;
}
