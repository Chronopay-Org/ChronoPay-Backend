# JWT Authentication

## Required Claims
All JWTs must include:
- `exp`: Numeric expiration timestamp (seconds since epoch)
- `iat`: Numeric issued-at timestamp (seconds since epoch)

## Environment Variables
| Variable | Description | Required |
| --- | --- | --- |
| `JWT_SECRET` | Token signing secret or public key | Yes |
| `JWT_ISSUER` | Expected `iss` claim value | Yes |
| `JWT_AUDIENCE` | Expected `aud` claim value | Yes |
| `JWT_LEEWAY` | Clock skew tolerance (seconds, non-negative integer) | Yes |
| `JWT_ALGORITHMS` | Comma-separated list of allowed signing algorithms | Yes |

## Allowed Algorithms
Valid values for `JWT_ALGORITHMS`: `HS256`, `HS384`, `HS512`, `RS256`, `RS384`, `RS512`, `ES256`, `ES384`, `ES512`, `PS256`, `PS384`, `PS512`

## Leeway
`JWT_LEEWAY` defines allowable clock drift between servers. Tokens with `exp`/`iat` within leeway of current time are accepted. Example: `JWT_LEEWAY=30` allows 30 seconds of clock skew.

## Security Notes
- **Fail-closed**: All validation failures return generic 401 responses with no internal details
- **No fallback**: Missing/invalid config crashes the app at startup
- **Strict validation**: Tokens missing required claims or using unlisted algorithms are rejected
- **Algorithm restriction**: Only algorithms specified in `JWT_ALGORITHMS` are accepted to prevent algorithm confusion attacks
- **IAT check**: Tokens with `iat` (issued-at) too far in the future are rejected to prevent pre-issued token abuse
