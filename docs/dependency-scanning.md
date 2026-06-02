# Dependency & Code Scanning

This repository runs automated dependency and code vulnerability scanning on Pull Requests.

Workflows added:

- `.github/workflows/audit.yml` — runs `npm audit --audit-level=high` on PRs. Fails the job if any vulnerabilities at severity `high` or `critical` are found.
- `.github/workflows/codeql.yml` — runs GitHub CodeQL analysis for JavaScript/TypeScript.

Suppression policy
- Temporary suppression can be applied by adding the label `audit/suppress` to the PR. When present, the npm audit step is skipped but the label and rationale should be recorded in the PR description.

Blocking PRs on high/critical findings
- Configure branch protection for the `main` branch and require the Code scanning status checks and the `Dependency audit (npm)` workflow to pass. This repository cannot change branch protection automatically — an administrator must enable the protections in the repository settings.

Guidance for maintainers
- To run the audit locally: `npm run audit`.
- For CI: `npm run audit:ci`.
- To enforce stricter rules, update `.github/workflows/audit.yml` or add additional guard steps.

Notes
- The CodeQL workflow creates code scanning alerts in the repository Security tab. Use the Security -> Code scanning alerts view to triage findings. Critical or high issues should be fixed or an explicit risk acceptance recorded.
