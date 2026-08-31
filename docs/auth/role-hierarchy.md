# RBAC Role Hierarchy

ChronoPay role inheritance is data-driven from `src/config/roles.json`.
Each key is a role and each value is the list of roles it implies.

Current hierarchy:

```text
admin -> support -> auditor
admin -> professional
admin -> customer
supplier (leaf)
```

`supplier` is a leaf role used by supplier-facing routes (e.g. the discount
curve editor), declared through `requireRole(["supplier", "admin"])`.

Route middleware declares the minimum accepted role:

```ts
router.get("/support-action", requireRole("support"), handler);
```

A caller with `support` is accepted. A caller with `admin` is also accepted
because `admin` implies `support`. A caller with only `auditor` is rejected.

## Startup Validation

The RBAC module validates `roles.json` when it loads:

- every implied role must also be declared
- duplicate or empty role names are rejected
- cyclic implications fail startup, for example `admin -> support -> admin`

## Deny Auditing

Denied RBAC checks emit audit events through `defaultAuditLogger`.
Audit metadata uses normalized, known role names and declared route roles only.
Raw header values are not logged, which avoids leaking attacker-controlled
strings into audit storage.

## Admin Token Authorization

`src/middleware/authorization.ts` guards admin-only endpoints with
`requireAdminToken`. Every denied access (missing header, invalid token, or an
unconfigured server token) emits a bounded audit event through
`defaultAuditLogger` (`AUTHZ_MISSING`, `AUTHZ_FORBIDDEN`, `AUTHZ_UNCONFIGURED`).
The raw token value is never written to the audit log, so attacker-controlled
strings cannot pollute audit storage.

## Security Notes

- Route declarations must use `requireRole("role")` or
  `requireRole(["role-a", "role-b"])`; unknown declarations throw during setup.
- Role checks are resolved through the hierarchy, not hard-coded branch checks.
- Header-authenticated routes reject unknown role headers instead of downgrading
  them to a lower-privilege role.
- The built hierarchy is frozen at startup; runtime mutation of shared role
  state is impossible, which keeps concurrent requests safe.
- Authorization denies return typed error envelopes and do not reveal internal
  hierarchy details beyond the normal authorization failure.
