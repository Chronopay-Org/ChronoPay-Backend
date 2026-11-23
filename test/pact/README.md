# Pact contract testing

This repository uses a lightweight Pact-style contract harness for backend-to-frontend compatibility checks.

## What is covered
- Consumer expectations are expressed as JSON contract snapshots under test/pact/contracts.
- Provider verification validates that the backend can satisfy those expectations locally and in CI.
- Sensitive values are redacted from recorded examples before they are persisted.

## How to run
- `npm run test:pact`
- `npm run verify:pact`
