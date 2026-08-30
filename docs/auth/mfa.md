# TOTP MFA

Multi-factor authentication using time-based one-time passwords (TOTP, RFC 6238).

## Endpoints

All endpoints are mounted under `/api/v1/auth` and require a valid `Authorization: Bearer <jwt>` header.

### `POST /api/v1/auth/mfa/enroll`

Starts enrollment. Generates a fresh random TOTP secret, encrypts it at rest, and returns the
details needed to provision an authenticator app.

Response `200`:

```json
{
  "success": true,
  "secret": "JBSWY3DPEHPK3PXP",
  "otpauthUrl": "otpauth://totp/ChronoPay:user@example.com?secret=JBSWY3DPEHPK3PXP&issuer=ChronoPay&digits=6&period=30&algorithm=SHA1",
  "digits": 6,
  "period": 30,
  "algorithm": "SHA1",
  "alreadyVerified": false
}
```

- `204`/`409` `MfaAlreadyEnrolledError` — the account already has an active (verified) enrollment.
- Pending enrollments may be re-enrolled; the previous secret is replaced.

### `POST /api/v1/auth/mfa/verify`

Confirms knowledge of the TOTP secret, marks the enrollment active on first success, and returns
a short-lived MFA challenge token plus its window.

Request:

```json
{ "code": "123456" }
```

Response `200`:

```json
{
  "success": true,
  "mfaToken": "<jwt>",
  "expiresInSec": 300,
  "freshUntilSec": 1710000000,
  "alreadyVerified": true
}
```

Errors:
- `400` — code missing or not 6–10 digits
- `401` `MfaNotEnrolledError` — no enrollment exists
- `401` `MfaInvalidCodeError` — wrong code (auto-disarm: clears a pending enrollment)
- `409` `MfaReplayDetectedError` — code was already used (replay protection)
- `500` `MfaConfigurationError` — `MFA_ENCRYPTION_KEY`/`MFA_CHALLENGE_SECRET` not provisioned

### Consuming challenges on high-risk routes

Challenges are carried in a dedicated header — never `Authorization` (which stays `Bearer`):

```
x-chronopay-mfa: <mfaToken>
```

`requireFreshMfa` mounts after `requireAuth` and validates the token signature, subject match, and
freshness. It accepts per-route overrides:

```ts
router.get("/sensitive", requireAuth(), requireFreshMfa(), handler);
// tighter window for a specific route:
router.post("/wire", requireAuth(), requireFreshMfa({ maxAgeMs: 5 * 60 * 1000 }), handler);
```

- `401` — missing/expired challenge (client should call the verify endpoint again)
- `403` — invalid signature, wrong subject, or claims malformed
- `500` — MFA not configured

## Semantics

- **Clock**: TOTP is computed for `Math.floor(nowMs / 1000 / period)`; `MFA_WINDOW_PERIODS`
  windows around the current step are accepted (`0 .. N`), each mapped to a counter step.
- **Replay protection**: success advances a row-level `last_used_counter` atomically
  (`UPDATE ... WHERE last_used_counter < $new`). Two concurrent requests with the same code —
  even in different time windows — cannot both succeed; the loser gets `409`.
- **Challenge tokens**: HS256 JWTs signed with `MFA_CHALLENGE_SECRET` (kept separate from
  `JWT_SECRET`). Claims: `sub` (user id), `iat`, `mfa_at` (must equal `iat`), `exp`. Freshness is
  anchored to `mfa_at`, so re-signing a challenge resets the freshness window; `exp` bounds the
  absolute token lifetime.
- **Encryption at rest**: the TOTP secret is encrypted with AES-256-GCM using a per-user key
  derived via HKDF-SHA256 from the master `MFA_ENCRYPTION_KEY` and a random per-user salt.
  Ciphertext, IV, auth tag, and salt are stored together; AAD binds the row to the user id.
- **Enrollment lifecycle**: while an enrollment is pending, the user can re-enroll to get a
  fresh secret. An already-active enrollment is protected: `enroll` returns `409`
  `MfaAlreadyEnrolledError`, so a stolen secret cannot silently replace an active one.

## Environment Variables

| Variable | Description | Required | Default |
| --- | --- | --- | --- |
| `MFA_ENCRYPTION_KEY` | 32-byte master key (hex or base64) encrypting secrets at rest | Yes* | — |
| `MFA_CHALLENGE_SECRET` | Secret signing the short-lived challenge tokens | Yes* | — |
| `MFA_ISSUER` | Label used in `otpauth://` URLs | No | `ChronoPay` |
| `MFA_FRESHNESS_MS` | Freshness window after a successful verify | No | `900000` (15 min) |
| `MFA_WINDOW_PERIODS` | Accepted 30s windows (including current) | No | `1` |
| `MFA_CHALLENGE_TTL_SEC` | Challenge token lifetime | No | `300` |

\* Missing secrets fail closed: enroll/verify return `500 MfaConfigurationError` (the routes are
permissionless beyond authentication, so an unconfigured deployment cannot silently skip MFA).

## Database

`mfa_enrollments` (migration `021`) is keyed by `user_id TEXT` (no FK to `users`, allowing the
table to exist before user records are replicated). Columns: `secret_ciphertext`,
`secret_iv`, `secret_auth_tag`, `kdf_salt`, `verified BOOLEAN`, `last_used_counter BIGINT NULL`.
`algorithm`/`digits`/`period` are fixed with CHECK constraints (`SHA1`/`6`/`30`).