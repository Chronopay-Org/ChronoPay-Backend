/**
 * GcpKmsAdapter — IHsmAdapter backed by Google Cloud Key Management Service.
 *
 * Behaviour
 * ──────────
 * • sign   → KeyManagementServiceClient.asymmetricSign(…)
 * • verify → KeyManagementServiceClient.getPublicKey(…) + Node.js crypto.verify()
 *            GCP Cloud KMS does not expose a server-side asymmetricVerify for
 *            asymmetric keys (only `macVerify` for HMAC, which is out of scope).
 *            The public key is retrieved on demand and used for local verification.
 * • rotate → KeyManagementServiceClient.createCryptoKeyVersion(…)
 *            Attempts to destroy the previous version via
 *            destroyCryptoKeyVersion(…) — failure is non-fatal.
 *
 * Key naming
 * ──────────
 * GCP key references use the full resource name:
 *   `projects/{p}/locations/{l}/keyRings/{kr}/cryptoKeys/{ck}/cryptoKeyVersions/{v}`
 * For rotation, callers may omit the `/cryptoKeyVersions/{v}` suffix and
 * supply the parent CryptoKey path instead.  The adapter creates a new version
 * and returns its resource name as the new key version.
 *
 * Algorithm mapping
 * ─────────────────
 * GCP encodes the algorithm on the *key version*, not in the request.
 * The `algorithm` field in the request is used to select the correct
 * Node.js crypto algorithm for local verification.
 *
 * Region failover
 * ────────────────
 * GCP Cloud KMS is a global/regional service. `locations` accepts multiple
 * location IDs. On an unavailability error the adapter re-creates the client
 * pointing at the next location using the same project + key-ring name, then
 * retries the operation.
 *
 * Retry policy
 * ─────────────
 * Transient errors (gRPC UNAVAILABLE, RESOURCE_EXHAUSTED) are retried using
 * the project-standard exponential back-off from `utils/retry-policy`.
 */

import { createVerify } from "crypto";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import type { IHsmAdapter } from "./hsm-adapter.interface.js";
import type {
  SignRequest,
  SignResponse,
  VerifyRequest,
  VerifyResponse,
  RotateRequest,
  RotateResponse,
  SigningAlgorithm,
} from "./types.js";
import { HsmError } from "./types.js";
import { RetryPolicy, DEFAULT_RETRY_CONFIG } from "../../utils/retry-policy.js";

// ---------------------------------------------------------------------------
// Algorithm → Node.js crypto algorithm mapping for local verification
// ---------------------------------------------------------------------------

/** Maps HSM algorithm to the hash name used by Node.js crypto for verification. */
const NODE_HASH_FOR_ALGORITHM: Record<SigningAlgorithm, string> = {
  RSASSA_PSS_SHA_256: "sha256",
  RSASSA_PSS_SHA_384: "sha384",
  RSASSA_PSS_SHA_512: "sha512",
  RSASSA_PKCS1_V1_5_SHA_256: "sha256",
  RSASSA_PKCS1_V1_5_SHA_384: "sha384",
  RSASSA_PKCS1_V1_5_SHA_512: "sha512",
  ECDSA_SHA_256: "sha256",
  ECDSA_SHA_384: "sha384",
  ECDSA_SHA_512: "sha512",
};

// gRPC status codes that indicate a transient infrastructure issue
const RETRIABLE_GRPC_CODES = new Set([
  4,  // DEADLINE_EXCEEDED
  8,  // RESOURCE_EXHAUSTED (quota / rate limit)
  10, // ABORTED
  14, // UNAVAILABLE
]);

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function isGrpcError(err: unknown): err is { code: number; details?: string; message: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as Record<string, unknown>).code === "number"
  );
}

/**
 * Maps gRPC status codes to the semantic error taxonomy.
 * gRPC codes: https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */
function classifyGcpError(err: unknown, keyId: string): HsmError {
  if (isGrpcError(err)) {
    const grpcCode = err.code;
    const msg = err.message ?? err.details ?? String(err);

    switch (grpcCode) {
      case 5:  // NOT_FOUND
        return new HsmError(`Key not found: ${keyId}`, "KEY_NOT_FOUND", {
          cause: err as unknown as Error,
        });
      case 7:  // PERMISSION_DENIED
      case 16: // UNAUTHENTICATED
        return new HsmError(`Permission denied for key: ${keyId}`, "PERMISSION_DENIED", {
          cause: err as unknown as Error,
        });
      case 3:  // INVALID_ARGUMENT — often algorithm mismatch or disabled
        if (/algorithm|purpose/i.test(msg)) {
          return new HsmError(`Algorithm not supported by key: ${keyId}`, "ALGORITHM_MISMATCH", {
            cause: err as unknown as Error,
          });
        }
        if (/disabled|destroy/i.test(msg)) {
          return new HsmError(`Key version is disabled: ${keyId}`, "KEY_DISABLED", {
            cause: err as unknown as Error,
          });
        }
        return new HsmError(`Provider validation error: ${msg}`, "PROVIDER_ERROR", {
          cause: err as unknown as Error,
        });
      case 9:  // FAILED_PRECONDITION — key disabled / wrong state
        return new HsmError(`Key is disabled or in wrong state: ${keyId}`, "KEY_DISABLED", {
          cause: err as unknown as Error,
        });
      default:
        return new HsmError(`KMS provider error (gRPC ${grpcCode}): ${msg}`, "PROVIDER_ERROR", {
          cause: err as unknown as Error,
        });
    }
  }

  return new HsmError(
    `Unknown HSM error: ${err instanceof Error ? err.message : String(err)}`,
    "UNKNOWN",
    { cause: err instanceof Error ? err : undefined },
  );
}

function isRetriableGcp(err: unknown): boolean {
  if (err instanceof HsmError) return false; // Already classified — don't retry
  if (!isGrpcError(err)) return false;
  return RETRIABLE_GRPC_CODES.has(err.code);
}

// ---------------------------------------------------------------------------
// Public configuration
// ---------------------------------------------------------------------------

export interface GcpKmsAdapterOptions {
  /**
   * Ordered list of GCP locations to try for region failover.
   * Each location replaces the `locations/{l}` segment in the key resource name.
   * Defaults to `["global"]`.
   *
   * Example: `["us-east1", "us-central1"]`
   */
  locations?: string[];

  /**
   * Optional factory for the KeyManagementServiceClient.
   * Used in tests to inject mock clients without real GCP credentials.
   */
  clientFactory?: (location?: string) => KeyManagementServiceClient;
}

// ---------------------------------------------------------------------------
// Helper: replace location in a GCP KMS resource name
// ---------------------------------------------------------------------------

function replaceLocation(resourceName: string, newLocation: string): string {
  // Resource names look like:
  //   projects/p/locations/us-east1/keyRings/kr/cryptoKeys/ck/cryptoKeyVersions/1
  return resourceName.replace(/\/locations\/[^/]+\//, `/locations/${newLocation}/`);
}

function extractParentKey(versionName: string): string {
  // Strip /cryptoKeyVersions/{v} to get the CryptoKey resource name
  const match = versionName.match(/^(.+\/cryptoKeys\/[^/]+)/);
  return match ? match[1] : versionName;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class GcpKmsAdapter implements IHsmAdapter {
  private readonly locations: string[];
  private readonly clientFactory: (location?: string) => KeyManagementServiceClient;
  private readonly retry: RetryPolicy;

  constructor(options: GcpKmsAdapterOptions = {}) {
    this.locations = options.locations?.length ? options.locations : ["global"];
    this.clientFactory =
      options.clientFactory ?? (() => new KeyManagementServiceClient());
    this.retry = new RetryPolicy({
      ...DEFAULT_RETRY_CONFIG,
      maxRetries: 3,
      initialDelay: 200,
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // sign
  // ──────────────────────────────────────────────────────────────────────────

  async sign(request: SignRequest): Promise<SignResponse> {
    if (!NODE_HASH_FOR_ALGORITHM[request.algorithm]) {
      throw new HsmError(
        `Unsupported algorithm: ${request.algorithm}`,
        "ALGORITHM_MISMATCH",
        { keyRef: request.key },
      );
    }

    const response = await this.withLocationFailover(request.key.keyId, async (keyId, client) => {
      return this.retry.execute(
        async () => {
          try {
            const [res] = await client.asymmetricSign({
              name: keyId,
              data: request.message,
            });
            return res;
          } catch (err) {
            if (isRetriableGcp(err)) throw err;
            throw classifyGcpError(err, keyId);
          }
        },
        (err) => isRetriableGcp(err),
      );
    });

    if (!response.signature) {
      throw new HsmError("GCP KMS returned empty signature", "PROVIDER_ERROR", {
        keyRef: request.key,
      });
    }

    return {
      signature: new Uint8Array(
        response.signature instanceof Uint8Array
          ? response.signature
          : Buffer.from(response.signature as string, "base64"),
      ),
      algorithm: request.algorithm,
      keyVersion: response.name ?? request.key.keyId,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // verify
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Verifies a signature by:
   * 1. Fetching the public key PEM from GCP KMS (getPublicKey)
   * 2. Verifying the signature locally using Node.js `crypto.createVerify`
   *
   * GCP Cloud KMS does not expose a server-side asymmetricVerify endpoint.
   */
  async verify(request: VerifyRequest): Promise<VerifyResponse> {
    const hashAlgorithm = NODE_HASH_FOR_ALGORITHM[request.algorithm];
    if (!hashAlgorithm) {
      throw new HsmError(
        `Unsupported algorithm: ${request.algorithm}`,
        "ALGORITHM_MISMATCH",
        { keyRef: request.key },
      );
    }

    // Retrieve the public key PEM from GCP KMS
    const publicKeyPem = await this.withLocationFailover(
      request.key.keyId,
      async (keyId, client) => {
        return this.retry.execute(
          async () => {
            try {
              const [pubKeyResponse] = await client.getPublicKey({ name: keyId });
              if (!pubKeyResponse.pem) {
                throw new HsmError("GCP KMS returned empty public key", "PROVIDER_ERROR");
              }
              return pubKeyResponse.pem;
            } catch (err) {
              if (err instanceof HsmError) throw err;
              if (isRetriableGcp(err)) throw err;
              throw classifyGcpError(err, keyId);
            }
          },
          (err) => isRetriableGcp(err),
        );
      },
    );

    // Verify locally using Node.js crypto
    try {
      const verifier = createVerify(hashAlgorithm);
      verifier.update(request.message);
      const valid = verifier.verify(
        publicKeyPem,
        Buffer.from(request.signature),
      );
      return {
        valid,
        keyVersion: request.key.keyId,
      };
    } catch {
      // Crypto verification errors (e.g. malformed signature) → not valid
      return { valid: false, keyVersion: request.key.keyId };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // rotate
  // ──────────────────────────────────────────────────────────────────────────

  async rotate(request: RotateRequest): Promise<RotateResponse> {
    const cryptoKeyName = extractParentKey(request.key.keyId);

    // 1. Find the current primary version before creating a new one
    const previousVersion = request.key.keyId.includes("/cryptoKeyVersions/")
      ? request.key.keyId
      : await this.withLocationFailover(cryptoKeyName, async (keyName, client) => {
          return this.retry.execute(
            async () => {
              try {
                const [key] = await client.getCryptoKey({ name: keyName });
                return key.primary?.name ?? keyName;
              } catch (err) {
                if (err instanceof HsmError) throw err;
                if (isRetriableGcp(err)) throw err;
                throw classifyGcpError(err, keyName);
              }
            },
            (err) => isRetriableGcp(err),
          );
        });

    // 2. Create a new key version
    const newVersionName = await this.withLocationFailover(
      cryptoKeyName,
      async (keyName, client) => {
        return this.retry.execute(
          async () => {
            try {
              const [newVersion] = await client.createCryptoKeyVersion({
                parent: keyName,
                cryptoKeyVersion: {},
              });
              return newVersion.name ?? keyName;
            } catch (err) {
              if (err instanceof HsmError) throw err;
              if (isRetriableGcp(err)) throw err;
              throw classifyGcpError(err, keyName);
            }
          },
          (err) => isRetriableGcp(err),
        );
      },
    );

    // 3. Schedule the previous version for destruction (non-fatal)
    if (previousVersion !== cryptoKeyName) {
      try {
        await this.withLocationFailover(previousVersion, async (versionName, client) => {
          return this.retry.execute(
            async () => {
              try {
                await client.destroyCryptoKeyVersion({ name: versionName });
              } catch (err) {
                if (err instanceof HsmError) throw err;
                if (isRetriableGcp(err)) throw err;
                throw classifyGcpError(err, versionName);
              }
            },
            (err) => isRetriableGcp(err),
          );
        });
      } catch {
        // Non-fatal: destroy failure is swallowed.
        // In production this would emit a metric/alert.
      }
    }

    return {
      newKeyVersion: newVersionName,
      previousKeyVersion: previousVersion,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Location failover helper
  // ──────────────────────────────────────────────────────────────────────────

  private async withLocationFailover<T>(
    keyId: string,
    fn: (resolvedKeyId: string, client: KeyManagementServiceClient) => Promise<T>,
  ): Promise<T> {
    let lastError: HsmError | undefined;

    for (let i = 0; i < this.locations.length; i++) {
      const location = this.locations[i];
      // For the first location use the keyId as-is; for subsequent locations
      // rewrite the location segment.
      const resolvedKeyId =
        i === 0 ? keyId : replaceLocation(keyId, location);

      const client = this.clientFactory(location);
      try {
        return await fn(resolvedKeyId, client);
      } catch (err) {
        if (err instanceof HsmError) {
          // Structural errors (not-found, permission) don't benefit from failover
          if (
            err.code === "KEY_NOT_FOUND" ||
            err.code === "PERMISSION_DENIED" ||
            err.code === "ALGORITHM_MISMATCH" ||
            err.code === "KEY_DISABLED"
          ) {
            throw err;
          }
          lastError = err;
          continue;
        }
        // Unexpected non-HsmError — classify and fail without failover
        throw classifyGcpError(err, keyId);
      }
    }

    throw (
      lastError ??
      new HsmError("All GCP locations exhausted", "REGION_UNAVAILABLE")
    );
  }
}
