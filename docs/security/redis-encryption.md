# Redis Idempotency Payload Encryption

ChronoPay can optionally encrypt idempotency payloads before writing them to Redis. This is intended for endpoints whose cached idempotent responses may contain sensitive data.

## What is encrypted

- The full idempotency state stored at `idempotency:req:<Idempotency-Key>`.
- Both `processing` and `completed` records use the same envelope format when encryption is enabled.
- The Redis key name is not encrypted.

When encryption is disabled, payloads continue to be stored as plaintext JSON for backward compatibility and low-overhead local development.

## Cryptography

- Algorithm: `AES-256-GCM`
- Nonce size: `12` random bytes per write
- Integrity: authenticated via the GCM authentication tag
- Associated data: fixed context string bound to the idempotency payload format

Operational requirements:

- `IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY` must decode to exactly 32 bytes.
- Keys must be generated with a cryptographically secure random source.
- Secret values must never be logged or committed.

Example key generation:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

For stronger operational hygiene, prefer generating keys from your secret manager or a dedicated crypto tool rather than committing generated values into shell history.

## Configuration

Environment variables:

- `IDEMPOTENCY_REDIS_ENCRYPTION_ENABLED`
- `IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY_ID`
- `IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY`
- `IDEMPOTENCY_REDIS_ENCRYPTION_PREVIOUS_KEYS`

`IDEMPOTENCY_REDIS_ENCRYPTION_PREVIOUS_KEYS` is a comma-separated list of `key-id:base64-key` pairs. These keys are used only for decryption during a rotation window.

Example:

```env
IDEMPOTENCY_REDIS_ENCRYPTION_ENABLED=true
IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY_ID=primary-2026-04
IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY=<32-byte-base64>
IDEMPOTENCY_REDIS_ENCRYPTION_PREVIOUS_KEYS=previous-2026-03:<32-byte-base64>
```

## Rollout

1. Generate a new 32-byte base64 key and store it in your secret manager.
2. Deploy with `IDEMPOTENCY_REDIS_ENCRYPTION_ENABLED=true` plus both the active key id and active key.
3. Restart application instances so new writes begin using encrypted envelopes.
4. Verify that duplicate requests still replay correctly and that Redis values no longer contain plaintext response fragments.

Backward compatibility note:

- Existing plaintext Redis payloads remain readable after encryption is enabled.
- New writes are encrypted immediately after rollout.

## Rotation

1. Generate a new active key and assign it a new key id.
2. Move the current active key into `IDEMPOTENCY_REDIS_ENCRYPTION_PREVIOUS_KEYS`.
3. Set the new values in:
   `IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY_ID` and `IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY`.
4. Deploy and restart the service.
5. Allow the idempotency TTL window to pass so entries written with the previous key expire naturally.
6. Remove the old key from `IDEMPOTENCY_REDIS_ENCRYPTION_PREVIOUS_KEYS`.

This flow is safe because new writes always use the active key, while reads can still decrypt entries written before the rotation.

## Failure modes

- Wrong or missing key id: decryption fails and the middleware fails closed rather than replaying unverifiable data.
- Corrupted ciphertext or auth tag: decryption fails because GCM integrity verification does not pass.
- Redis unavailable: the middleware bypasses idempotency storage rather than exposing encryption secrets or partial state.

## Security notes

- Do not reuse idempotency encryption keys for unrelated features.
- Do not reuse previous keys longer than the Redis TTL window requires.
- Restrict key access to deployment systems and operators who already manage production secrets.
- Treat Redis dumps, backups, and observability tooling as sensitive even when encryption is enabled, because Redis key names and access patterns remain visible.
