# Security Review

Review scope: issue #1296, authentication identity and role handling.

| # | Severity | File | Lines | Vulnerability | Confidence |
|---|----------|------|-------|---------------|------------|
| 1 | 🟠 HIGH | `src/middleware/auth.ts`; `src/middleware/rbac.ts` | `auth.ts:96-121`; `rbac.ts:224-261, 290-311` | The authorization middleware trusted caller-controlled identity and role headers without verifying a JWT. This allowed unauthenticated callers to claim admin access and forge separate identities for payout replay approval. | 9/10 |

Status: remediated by commit `4cdb89d` on branch `fix/1296-authenticate-from-jwt`. Authorization now derives the user ID and role from a verified bearer JWT.
