# RBAC Role Hierarchy

ChronoPay role inheritance is data-driven from `src/config/roles.json`.
Each key is a role and each value is the list of roles it implies.

Current hierarchy:

```text
admin -> support -> auditor
admin -> professional
admin -> customer
```

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

## Security Notes

- Route declarations must use `requireRole("role")` or
  `requireRole(["role-a", "role-b"])`; unknown declarations throw during setup.
- Role checks are resolved through the hierarchy, not hard-coded branch checks.
- Header-authenticated routes reject unknown role headers instead of downgrading
  them to a lower-privilege role.
- Authorization denies return typed error envelopes and do not reveal internal
  hierarchy details beyond the normal authorization failure.
