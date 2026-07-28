# SOC2 Change-Management Deployment Guardrails

## Overview

ChronoPay Backend implements strict SOC2 change-management guardrails to ensure that **every production deployment is verifiably linked to a merged Pull Request (PR)**. This enforcement mechanism guarantees traceable code provenance, compliance auditing, and emergency rollback safeguards.

## Key Features

1. **Pre-Deploy Verification**: Validates that target git commits/tags correlate directly with a merged PR on GitHub.
2. **Audit Ledger Persistence**: Appends immutable deployment records containing deploy ID, commit hash, PR details, environment, timestamp, actor, and status to `ops/deploy-audit-ledger.json`.
3. **Manual Override & Alarms**: Supports emergency manual overrides with mandatory rationale logging and structured high-severity alarm emission (`[SOC2_ALARM]`) to `stderr`.
4. **Edge-Case Support**:
   - **Rollback Deploys**: Verifies rollback targets against prior approved audit ledger records or merged rollback PRs.
   - **Hotfix Branches**: Accommodates hotfixes while maintaining pull-request verification or emergency override alarms.
   - **Tag Re-tagging**: Prevents unauthorized tag re-deployments without an audit trail.

---

## Pre-Deploy CLI Tool (`verify-deploy-pr.ts`)

The pre-deploy script executes before container build or release deployment.

### Usage

```bash
# Verify current HEAD commit against PR #520
npx tsx scripts/verify-deploy-pr.ts --pr 520

# Verify specific commit in staging environment
npm run verify-deploy-pr -- --commit abc1234 --pr 101 --env staging

# Emergency override for urgent incident resolution
npm run verify-deploy-pr -- --commit abc1234 --override --override-reason "Emergency hotfix for outage INC-402"
```

### CLI Parameters

| Option | Alias | Description | Default |
| :--- | :--- | :--- | :--- |
| `--commit <hash>` | `-c` | Target git commit SHA | `GITHUB_SHA` or `git rev-parse HEAD` |
| `--pr <number>` | `-p` | Linked Pull Request number | `PR_NUMBER` env var |
| `--env <environment>` | `-e` | Deployment environment | `production` |
| `--type <type>` | `-t` | Deployment type (`STANDARD`, `ROLLBACK`, `HOTFIX`, `TAG_REDEPLOY`) | `STANDARD` |
| `--override` | | Enables manual override mode | `false` |
| `--override-reason <msg>` | | Required justification for manual override | `undefined` |
| `--ledger-path <path>` | | Custom audit ledger file path | `ops/deploy-audit-ledger.json` |
| `--json` | | Formats CLI output as JSON | `false` |
| `--help` | `-h` | Prints usage information | |

### Exit Codes

- `0`: Deploy approved (merged PR verified & recorded in audit ledger).
- `1`: Deploy blocked (PR missing, unmerged, or error encountered).
- `2`: Deploy approved via manual override (SOC2 alarm emitted & recorded).

---

## Audit Ledger Schema

Deployment records are stored in `ops/deploy-audit-ledger.json` (or path specified by `AUDIT_LEDGER_PATH`).

```json
[
  {
    "deployId": "dep_1753704000000_a1b2c3d4",
    "commitHash": "e3f89012a4b56789c0123456789abcdef0123456",
    "prNumber": 520,
    "prTitle": "feat: SOC2 deploy-to-PR guardrail",
    "prUrl": "https://github.com/Chronopay-Org/ChronoPay-Backend/pull/520",
    "environment": "production",
    "status": "APPROVED",
    "timestamp": "2026-07-28T13:00:00.000Z",
    "override": false,
    "overrideReason": null,
    "deployType": "STANDARD",
    "actor": "ci-runner",
    "gitRef": "refs/heads/main"
  }
]
```

---

## Manual Overrides & Alarm Emission

In rare emergency scenarios (e.g., severe service outage requiring an immediate hotfix), deployments can be forced using `--override --override-reason "<reason>"`.

### Alarm Mechanics

When `--override` is invoked:
1. The pre-deploy script emits a structured alarm to `stderr`:
   ```text
   [SOC2_ALARM] MANUAL DEPLOY OVERRIDE DETECTED: Deploy dep_1753704000000_a1b2c3d4 (commit e3f8901) in environment 'production' overridden by 'admin'. Reason: Emergency hotfix for outage INC-402
   ```
2. An audit entry with `status: "OVERRIDDEN"` and `override: true` is persisted to the ledger.
3. The process exits with code `2`.

---

## Edge Case Guidelines

### 1. Rollback Deployments
When rolling back to a previous commit, execute with `--type ROLLBACK`. The guardrail checks if the target commit already exists in the audit ledger as an approved deployment or has a merged rollback PR.

### 2. Hotfix Branches
Hotfixes submitted via branch workflow must create a PR and merge before deploy. If an unmerged hotfix must be deployed immediately, use `--override --override-reason "<incident-id>"`.

### 3. Tag Re-Deployments
Re-deploying an existing version tag requires passing `--type TAG_REDEPLOY`. The script verifies that the underlying tag commit traces back to a previously approved deployment.
