# HSM Adapter

The HSM adapter provides a unified interface for hardware security module (HSM) operations across cloud KMS providers. Signing operations are available behind either AWS KMS or GCP Cloud KMS with identical semantics.

## Interface

```ts
interface IHsmAdapter {
  sign(request: SignRequest): Promise<SignResponse>;
  verify(request: VerifyRequest): Promise<VerifyResponse>;
  rotate(request: RotateRequest): Promise<RotateResponse>;
}
```

All three operations accept a `HsmKeyRef` identifying the key by its provider-native ID (ARN for AWS, full resource name for GCP).

## Supported Algorithms

| Algorithm                  | Description                              |
| -------------------------- | ---------------------------------------- |
| `ECDSA_SHA_256`            | ECDSA with P-256 and SHA-256             |
| `ECDSA_SHA_384`            | ECDSA with P-384 and SHA-384             |
| `ECDSA_SHA_512`            | ECDSA with P-521/P-384 and SHA-512       |
| `RSASSA_PSS_SHA_256`       | RSA-PSS with SHA-256                     |
| `RSASSA_PSS_SHA_384`       | RSA-PSS with SHA-384                     |
| `RSASSA_PSS_SHA_512`       | RSA-PSS with SHA-512                     |
| `RSASSA_PKCS1_V1_5_SHA_256`| RSASSA-PKCS1-v1_5 with SHA-256           |
| `RSASSA_PKCS1_V1_5_SHA_384`| RSASSA-PKCS1-v1_5 with SHA-384           |
| `RSASSA_PKCS1_V1_5_SHA_512`| RSASSA-PKCS1-v1_5 with SHA-512           |

Only asymmetric algorithms are included. Symmetric HMAC variants are excluded because they cannot be verified externally without sharing key material.

## Error Taxonomy

All errors are thrown as `HsmError` with a structured `code` field:

| Code                  | Meaning                                                  |
| --------------------- | -------------------------------------------------------- |
| `KEY_NOT_FOUND`       | The referenced key does not exist in the KMS             |
| `PERMISSION_DENIED`   | Credentials lack the required IAM/IAP permissions        |
| `KEY_DISABLED`        | The key version is disabled or scheduled for destruction  |
| `ALGORITHM_MISMATCH`  | The requested algorithm is incompatible with the key     |
| `INVALID_SIGNATURE`   | The signature bytes are syntactically invalid            |
| `REGION_UNAVAILABLE`  | All configured regions/locations are unreachable         |
| `PROVIDER_ERROR`      | A retriable or unclassified KMS provider error           |
| `UNKNOWN`             | An unexpected error that could not be classified         |

`verify()` returns `{ valid: false }` rather than throwing for an invalid signature, so callers can distinguish a *wrong* signature from an *infrastructure* failure.

## AWS KMS Adapter

### Instantiation

```ts
import { AwsKmsAdapter } from './services/hsm/index.js';

const adapter = new AwsKmsAdapter({
  regions: ['us-east-1', 'us-west-2'],   // failover order
});
```

### Key Reference

Use the full Key ARN or alias ARN:

```ts
const key = {
  keyId: 'arn:aws:kms:us-east-1:123456789012:key/abcd-1234',
  alias: 'payment-signing-key',
};
```

### Region Failover

On a `PROVIDER_ERROR` (5xx or network failure) the adapter retries with the next region in `regions`. `KEY_NOT_FOUND`, `PERMISSION_DENIED`, `ALGORITHM_MISMATCH`, and `KEY_DISABLED` do **not** trigger failover — those are logical errors that won't be resolved by trying another region.

### Key Rotation

Rotation calls `RotateKeyOnDemandCommand`. AWS re-uses the same key ARN but generates new key material. Older key material remains available for decryption/verification according to the configured deletion schedule.

### Required IAM Permissions

| Operation | Permission              |
| --------- | ----------------------- |
| `sign`    | `kms:Sign`              |
| `verify`  | `kms:Verify`            |
| `rotate`  | `kms:RotateKeyOnDemand`, `kms:DescribeKey` |

## GCP Cloud KMS Adapter

### Instantiation

```ts
import { GcpKmsAdapter } from './services/hsm/index.js';

const adapter = new GcpKmsAdapter({
  locations: ['us-east1', 'us-central1'],  // failover order
});
```

### Key Reference

Use the full CryptoKeyVersion resource name for `sign`/`verify`, or the CryptoKey path for `rotate`:

```ts
// sign / verify
const versionKey = {
  keyId: 'projects/my-proj/locations/us-east1/keyRings/my-ring/cryptoKeys/my-key/cryptoKeyVersions/1',
};

// rotate (creates a new version automatically)
const cryptoKey = {
  keyId: 'projects/my-proj/locations/us-east1/keyRings/my-ring/cryptoKeys/my-key',
};
```

### Location Failover

On `PROVIDER_ERROR` the adapter rewrites the `locations/{l}` segment in the key resource name and re-creates the client. `KEY_NOT_FOUND`, `PERMISSION_DENIED`, `ALGORITHM_MISMATCH`, and `KEY_DISABLED` skip failover.

### Key Rotation

Rotation calls `createCryptoKeyVersion` to create a new key version, then calls `destroyCryptoKeyVersion` on the previous primary. The destroy step is **non-fatal** — a failure there is silently swallowed (and would emit a metric/alert in production) so the rotation still completes.

### Required IAM Roles

| Operation | Permission                                          |
| --------- | --------------------------------------------------- |
| `sign`    | `roles/cloudkms.signerVerifier`                     |
| `verify`  | `roles/cloudkms.signerVerifier`                     |
| `rotate`  | `roles/cloudkms.admin` or `roles/cloudkms.cryptoKeyVersions.create` + `destroy` |

## Retry Policy

Both adapters use the project-standard `RetryPolicy` (exponential back-off with jitter):

- **Max retries**: 3
- **Initial delay**: 200 ms
- **Back-off factor**: 2×
- **Max delay**: 10 s

Retriable conditions:
- **AWS**: HTTP 429 (throttle) or HTTP 5xx
- **GCP**: gRPC `UNAVAILABLE` (14), `RESOURCE_EXHAUSTED` (8), `DEADLINE_EXCEEDED` (4), `ABORTED` (10)

## Usage Example

```ts
import { AwsKmsAdapter, type IHsmAdapter, type SignRequest } from './services/hsm/index.js';

const hsm: IHsmAdapter = new AwsKmsAdapter({
  regions: ['us-east-1', 'us-west-2'],
});

// Sign
const signReq: SignRequest = {
  key: { keyId: 'arn:aws:kms:us-east-1:123456789012:key/my-key', alias: 'payment' },
  message: Buffer.from('hello world'),
  algorithm: 'ECDSA_SHA_256',
};
const { signature, keyVersion } = await hsm.sign(signReq);

// Verify
const { valid } = await hsm.verify({
  key: signReq.key,
  message: signReq.message,
  signature,
  algorithm: 'ECDSA_SHA_256',
});
console.assert(valid, 'signature must be valid');

// Rotate
const { newKeyVersion, previousKeyVersion } = await hsm.rotate({ key: signReq.key });
console.log(`Rotated ${previousKeyVersion} → ${newKeyVersion}`);
```

## Testing

Contract tests are in `src/services/hsm/__tests__/`:

| File                        | Description                                           |
| --------------------------- | ----------------------------------------------------- |
| `hsm-adapter.contract.ts`   | Shared contract suite run for both adapters           |
| `aws-kms-adapter.test.ts`   | AWS-specific tests + contract suite wiring            |
| `gcp-kms-adapter.test.ts`   | GCP-specific tests + contract suite wiring            |

Both adapters accept a `clientFactory` option for injecting mock clients during tests — no real cloud credentials are required.

```bash
# Run only HSM tests
npx jest --testPathPattern="hsm"

# With coverage
npm run test:coverage -- --testPathPattern="hsm"
```

## Security Notes

- Key material **never leaves** the KMS. Signing and verification happen inside the HSM.
- The adapter does not cache keys, signatures, or credentials.
- The `keyId` field in `HsmKeyRef` is treated as a trusted configuration value — never accept it from untrusted user input.
- Symmetric HMAC algorithms are intentionally excluded from `SigningAlgorithm` to prevent accidental use of key material that could be extracted.
