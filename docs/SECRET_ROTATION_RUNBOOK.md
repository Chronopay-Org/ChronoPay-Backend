# Secret Rotation Runbook: ChronoPay Backend

This document outlines the standard operating procedure for rotating sensitive secrets (e.g., JWT signing keys, API keys, Stellar secret keys) within the ChronoPay Backend architecture.

## Overview

Regular secret rotation is a security best practice that limits the impact of potential secret leakage. Our architecture supports **zero-downtime rotation** by allowing multiple secret versions to coexist during a transition window.

### Scope

This runbook applies to:
- `JWT_SECRET`: Used for signing and verifying authentication tokens.
- `API_KEY`: Used for external service integration.
- `STELLAR_SECRET_KEY`: Used for transaction signing.

---

## Rotation Frequency

- **Standard Rotation**: Every 90 days.
- **Emergency Rotation**: Immediately upon suspected compromise.

---

## Standard Rotation Process (Step-by-Step)

The rotation process involves four phases: **Prepare, Deploy (Dual-Mode), Transition, and Cleanup.**

### Phase 1: Prepare
1.  Identify the secret to rotate (e.g., `JWT_SECRET`).
2.  Generate a new high-entropy secret.
    - Example (Unix): `openssl rand -base64 32`

### Phase 2: Deploy (Dual-Mode)
1.  Update the environment configuration to include the **new secret** as the primary version and the **current secret** as the previous version.
2.  Configuration updates:
    - Set `JWT_SECRET` = `[NEW_SECRET]`
    - Set `JWT_SECRET_PREV` = `[OLD_SECRET]`
3.  Deploy the updated configuration to the environment (e.g., CI/CD, Kubernetes Secrets, or `.env`).
4.  Restart the service to apply changes.

### Phase 3: Transition (Verification Window)
1.  Wait for the transition window to complete (e.g., 24 hours).
2.  The application will now:
    - Use `JWT_SECRET` (the new one) for **new** operations (e.g., signing new tokens).
    - Use both `JWT_SECRET` and `JWT_SECRET_PREV` for **validation** (e.g., verifying old tokens).
3.  Monitor logs for `ConfigError` or unexpected authentication failures.

### Phase 4: Cleanup
1.  Once the transition window has passed and old tokens/requests using the old secret are no longer relevant:
2.  Remove `JWT_SECRET_PREV` from the environment.
3.  Restart the service to finalize the rotation.

---

## Failure-Mode Handling

### Scenario A: New secret is invalid/misconfigured
- **Symptom**: Service fails to start or shows high error rates in authentication.
- **Action**: Roll back the environment configuration to the previous known-good state (i.e., restore the old secret as `JWT_SECRET` and remove `JWT_SECRET_PREV`).

### Scenario B: Unexpected downtime during rotation
- **Symptom**: Application cannot reach the secret manager or environment variable updates fail.
- **Action**: Halt the rotation process, investigate the infrastructure issue, and resume only when the environment is stable.

### Scenario C: Compromise detected during rotation
- **Symptom**: Suspicious activity using both old and new secrets.
- **Action**: Perform an **Emergency Rotation** (see below).

---

## Emergency Rotation

In case of a suspected compromise:
1.  Immediately invalidate the old secret by removing it from all configurations.
2.  Generate and deploy a new secret as the **only** active version.
3.  Force a re-authentication for all users (e.g., invalidate all active sessions).
4.  Revoke any compromised external API keys or Stellar credentials.

---

## Security Considerations

- **Entropy**: Secrets must be at least 32 characters long and generated using a cryptographically secure random number generator.
- **Access Control**: Only authorized personnel/CI-CD pipelines should have access to update secret configurations.
- **Logging**: Never log the actual secret values. Log only the success/failure of a rotation or refresh operation.
- **Transport**: Ensure secrets are encrypted at rest and in transit during deployment.

---

## Verification Checklist

- [ ] New secret generated with sufficient entropy.
- [ ] Both primary and previous secrets are correctly set in the environment.
- [ ] Service restarted and health checks pass.
- [ ] New operations (e.g., login) use the new secret.
- [ ] Existing operations (e.g., using old tokens) still work during the transition window.
- [ ] Old secret removed after the transition window.
- [ ] Final health checks and monitoring confirm a successful rotation.
