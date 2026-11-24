# OAuth2 / OIDC Login

Endpoints are mounted under `/api/v1/auth`:

- `GET /oauth/:provider/start` — validates the provider, generates PKCE + state + nonce, sets
  `oauth2_state`, `oauth2_pkce`, and `oauth2_nonce` as httpOnly cookies (10 minute lifetime), and
  returns `{ authorization_url }`.
- `GET /oauth/:provider/callback` — validates state/PKCE, exchanges the code, validates the OIDC
  ID token, fetches the provider profile, and returns a 24 hour application JWT.

Supported providers are env-driven: `google` (OIDC; requested with the `openid` scope) and
`github` (plain OAuth2, no ID token).

## Application JWT subject

The `sub` claim is **namespaced by provider**:

```
<provider>:<provider-user-id>
```

Example: GitHub user `12345` becomes `github:12345`; Google user `12345` becomes `google:12345`.

Provider user ids are only unique inside a single provider. Signing `sub` with the raw provider id
let two different people — one per provider — resolve to the same ChronoPay identity and therefore
reach each other's bookings and MFA enrolment. Namespacing makes the two subjects distinct.

The `user.id` field in the callback response remains the provider-local id; only the JWT `sub`
carries the namespace. `user.provider` is also present in the JWT, so `sub` can be re-derived.

### Migration impact for existing tokens

Application JWTs are valid for 24 hours and there is no server-side session store, so:

- Tokens issued before this change still verify (the signing key, issuer, and audience did not
  change) but carry the legacy raw `sub` (e.g. `12345`).
- Anything that uses `sub` to look up a user, MFA enrolment, or booking ownership will not match
  `12345` against the new `google:12345` value. Treat such tokens as unauthenticated for those
  lookups and require a fresh login; they age out within 24 hours at most.
- If a rollout needs to accept both formats, do it explicitly (accept the legacy raw id only while
  `provider` is present and the token predates the deploy), then remove the fallback once the
  24 hour window has passed.
- Clients that cache or display `sub` should read it from the new login rather than persisting the
  old value.

## OIDC nonce validation

For OIDC providers (providers configured with the `openid` scope, currently Google) the callback
requires **both** an `id_token` in the token response and the `oauth2_nonce` cookie set at
`/start`. The payload is decoded as JWT base64url (not plain base64) and its `nonce` claim must match
the cookie. Every failure is a `400` — validation is never skipped:

| Error | Cause |
| --- | --- |
| `missing_id_token` | OIDC provider returned no `id_token` |
| `missing_nonce` | The `oauth2_nonce` cookie is absent (flow restarted in another tab, cookies dropped) |
| `malformed_id_token` | Not a three-part JWT, payload is not base64url JSON, or payload is not an object |
| `nonce_mismatch` | The `nonce` claim is missing or does not match the stored value |

The nonce is compared in constant time, and the user-info request is only made after validation
passes. For non-OIDC providers an ID token is not required, but if one is returned alongside a
nonce cookie it is validated the same way rather than trusted.

All three OAuth cookies are cleared on every callback failure path (provider error, missing
parameters, unknown provider, state mismatch, missing/invalid PKCE, token exchange failure, and the
ID token failures above), as well as on success.

## Known follow-up

The ID token payload is decoded but its signature is not verified against the provider JWKS. The
token is received over TLS directly from the provider's token endpoint during the code exchange, so
the payload is trusted for nonce validation; signature verification with
`jose.createRemoteJWKSet` remains a hardening follow-up.
