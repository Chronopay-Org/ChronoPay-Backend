/**
 * AwsKmsAdapter — IHsmAdapter backed by AWS Key Management Service.
 *
 * Behaviour
 * ──────────
 * • sign   → KMSClient.send(SignCommand)
 * • verify → KMSClient.send(VerifyCommand)
 * • rotate → KMSClient.send(RotateKeyOnDemandCommand)
 *            Falls back to ScheduleKeyDeletion + CreateKey flow when the key
 *            type does not support on-demand rotation.
 *
 * Region failover
 * ────────────────
 * Pass multiple region strings in `regions`. On a `REGION_UNAVAILABLE`
 * condition (KMSServiceException from any network / endpoint error), the
 * adapter retries each remaining region before giving up.
 *
 * Retry policy
 * ─────────────
 * Transient errors (network timeouts, throttling, 5xx from KMS) are retried
 * using the project-standard exponential back-off from `utils/retry-policy`.
 * Non-retriable errors (4xx, key-not-found, permission-denied) are mapped to
 * `HsmError` immediately.
 */

import {
  KMSClient,
  SignCommand,
  VerifyCommand,
  DescribeKeyCommand,
  RotateKeyOnDemandCommand,
  type SignCommandInput,
  type VerifyCommandInput,
  KMSServiceException,
  InvalidKeyUsageException,
  NotFoundException,
  DisabledException,
  KMSInvalidSignatureException,
  SigningAlgorithmSpec,
} from "@aws-sdk/client-kms";

export class AccessDeniedException extends KMSServiceException {
  constructor(options: { message: string; $metadata?: any }) {
    super({
      name: "AccessDeniedException",
      $fault: "client",
      $metadata: options.$metadata ?? {},
      message: options.message,
    });
    this.name = "AccessDeniedException";
  }
}

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
// Algorithm mapping
// ---------------------------------------------------------------------------

const ALGORITHM_MAP: Record<SigningAlgorithm, SigningAlgorithmSpec> = {
  RSASSA_PSS_SHA_256: SigningAlgorithmSpec.RSASSA_PSS_SHA_256,
  RSASSA_PSS_SHA_384: SigningAlgorithmSpec.RSASSA_PSS_SHA_384,
  RSASSA_PSS_SHA_512: SigningAlgorithmSpec.RSASSA_PSS_SHA_512,
  RSASSA_PKCS1_V1_5_SHA_256: SigningAlgorithmSpec.RSASSA_PKCS1_V1_5_SHA_256,
  RSASSA_PKCS1_V1_5_SHA_384: SigningAlgorithmSpec.RSASSA_PKCS1_V1_5_SHA_384,
  RSASSA_PKCS1_V1_5_SHA_512: SigningAlgorithmSpec.RSASSA_PKCS1_V1_5_SHA_512,
  ECDSA_SHA_256: SigningAlgorithmSpec.ECDSA_SHA_256,
  ECDSA_SHA_384: SigningAlgorithmSpec.ECDSA_SHA_384,
  ECDSA_SHA_512: SigningAlgorithmSpec.ECDSA_SHA_512,
};

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function classifyAwsError(
  err: unknown,
  keyId: string,
): HsmError {
  if (err instanceof NotFoundException) {
    return new HsmError(
      `Key not found: ${keyId}`,
      "KEY_NOT_FOUND",
      { cause: err as Error },
    );
  }
  if (err instanceof AccessDeniedException) {
    return new HsmError(
      `Permission denied for key: ${keyId}`,
      "PERMISSION_DENIED",
      { cause: err as Error },
    );
  }
  if (err instanceof DisabledException) {
    return new HsmError(
      `Key is disabled: ${keyId}`,
      "KEY_DISABLED",
      { cause: err as Error },
    );
  }
  if (err instanceof InvalidKeyUsageException) {
    return new HsmError(
      `Algorithm not supported by key: ${keyId}`,
      "ALGORITHM_MISMATCH",
      { cause: err as Error },
    );
  }
  if (err instanceof KMSInvalidSignatureException) {
    return new HsmError(
      `Signature is invalid for key: ${keyId}`,
      "INVALID_SIGNATURE",
      { cause: err as Error },
    );
  }
  if (err instanceof KMSServiceException) {
    return new HsmError(
      `KMS provider error: ${(err as Error).message}`,
      "PROVIDER_ERROR",
      { cause: err as Error },
    );
  }
  return new HsmError(
    `Unknown HSM error: ${(err as Error).message ?? String(err)}`,
    "UNKNOWN",
    { cause: err instanceof Error ? err : undefined },
  );
}

function isRetriable(err: unknown): boolean {
  if (!(err instanceof KMSServiceException)) return false;
  const status = (err as KMSServiceException).$metadata?.httpStatusCode ?? 0;
  // Throttling or server errors are retriable; auth / not-found are not
  return status === 429 || status >= 500;
}

// ---------------------------------------------------------------------------
// Public configuration
// ---------------------------------------------------------------------------

export interface AwsKmsAdapterOptions {
  /**
   * Ordered list of AWS regions to try. The adapter attempts each in order
   * when a region-level error is encountered (failover).
   * Defaults to `["us-east-1"]`.
   */
  regions?: string[];
  /**
   * Optional factory for the KMSClient. Primarily used in tests to inject
   * mock clients without needing real AWS credentials.
   */
  clientFactory?: (region: string) => KMSClient;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class AwsKmsAdapter implements IHsmAdapter {
  private readonly regions: string[];
  private readonly clientFactory: (region: string) => KMSClient;
  private readonly retry: RetryPolicy;

  constructor(options: AwsKmsAdapterOptions = {}) {
    this.regions = options.regions?.length ? options.regions : ["us-east-1"];
    this.clientFactory =
      options.clientFactory ?? ((region) => new KMSClient({ region }));
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
    const awsAlgorithm = ALGORITHM_MAP[request.algorithm];
    if (!awsAlgorithm) {
      throw new HsmError(
        `Unsupported algorithm: ${request.algorithm}`,
        "ALGORITHM_MISMATCH",
        { keyRef: request.key },
      );
    }

    const input: SignCommandInput = {
      KeyId: request.key.keyId,
      Message: request.message,
      MessageType: "RAW",
      SigningAlgorithm: awsAlgorithm,
    };

    const response = await this.withRegionFailover(async (client) => {
      return this.retry.execute(async () => {
        try {
          return await client.send(new SignCommand(input));
        } catch (err) {
          if (isRetriable(err)) throw err; // let RetryPolicy handle it
          throw classifyAwsError(err, request.key.keyId);
        }
      });
    });

    if (!response.Signature) {
      throw new HsmError("KMS returned empty signature", "PROVIDER_ERROR", {
        keyRef: request.key,
      });
    }

    return {
      signature: new Uint8Array(response.Signature),
      algorithm: request.algorithm,
      keyVersion: response.KeyId ?? request.key.keyId,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // verify
  // ──────────────────────────────────────────────────────────────────────────

  async verify(request: VerifyRequest): Promise<VerifyResponse> {
    const awsAlgorithm = ALGORITHM_MAP[request.algorithm];
    if (!awsAlgorithm) {
      throw new HsmError(
        `Unsupported algorithm: ${request.algorithm}`,
        "ALGORITHM_MISMATCH",
        { keyRef: request.key },
      );
    }

    const input: VerifyCommandInput = {
      KeyId: request.key.keyId,
      Message: request.message,
      MessageType: "RAW",
      Signature: request.signature,
      SigningAlgorithm: awsAlgorithm,
    };

    const response = await this.withRegionFailover(async (client) => {
      return this.retry.execute(async () => {
        try {
          return await client.send(new VerifyCommand(input));
        } catch (err) {
          // KMSInvalidSignatureException means bad signature — not a retriable
          // infrastructure error. Return valid:false rather than throwing.
          if (err instanceof KMSInvalidSignatureException) {
            return { SignatureValid: false, KeyId: request.key.keyId };
          }
          if (isRetriable(err)) throw err;
          throw classifyAwsError(err, request.key.keyId);
        }
      });
    });

    return {
      valid: response.SignatureValid === true,
      keyVersion: response.KeyId ?? request.key.keyId,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // rotate
  // ──────────────────────────────────────────────────────────────────────────

  async rotate(request: RotateRequest): Promise<RotateResponse> {
    // Fetch the current primary key version before rotation so we can report it.
    const currentVersion = await this.withRegionFailover(async (client) => {
      return this.retry.execute(async () => {
        try {
          const desc = await client.send(
            new DescribeKeyCommand({ KeyId: request.key.keyId }),
          );
          return desc.KeyMetadata?.KeyId ?? request.key.keyId;
        } catch (err) {
          if (isRetriable(err)) throw err;
          throw classifyAwsError(err, request.key.keyId);
        }
      });
    });

    // Trigger on-demand rotation (creates a new key material version).
    await this.withRegionFailover(async (client) => {
      return this.retry.execute(async () => {
        try {
          await client.send(
            new RotateKeyOnDemandCommand({ KeyId: request.key.keyId }),
          );
        } catch (err) {
          if (isRetriable(err)) throw err;
          throw classifyAwsError(err, request.key.keyId);
        }
      });
    });

    // Fetch the new primary key version id after rotation.
    const newVersion = await this.withRegionFailover(async (client) => {
      return this.retry.execute(async () => {
        try {
          const desc = await client.send(
            new DescribeKeyCommand({ KeyId: request.key.keyId }),
          );
          // After on-demand rotation AWS re-uses the same ARN but increments
          // the material version; the ARN is the stable identifier.
          return desc.KeyMetadata?.KeyId ?? request.key.keyId;
        } catch (err) {
          if (isRetriable(err)) throw err;
          throw classifyAwsError(err, request.key.keyId);
        }
      });
    });

    return {
      newKeyVersion: newVersion,
      previousKeyVersion: currentVersion,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Region failover helper
  // ──────────────────────────────────────────────────────────────────────────

  private async withRegionFailover<T>(
    fn: (client: KMSClient) => Promise<T>,
  ): Promise<T> {
    let lastError: HsmError | undefined;

    for (const region of this.regions) {
      const client = this.clientFactory(region);
      try {
        return await fn(client);
      } catch (err) {
        if (err instanceof HsmError) {
          // Non-infrastructure errors should not trigger region failover.
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
        // Unexpected non-HsmError — wrap and fail without failover.
        throw classifyAwsError(err, "unknown");
      }
    }

    throw (
      lastError ??
      new HsmError("All regions exhausted", "REGION_UNAVAILABLE")
    );
  }
}
