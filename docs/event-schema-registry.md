# Event Schema Registry

ChronoPay uses a versioned event schema registry to ensure domain events remain backward compatible for downstream consumers.

## Purpose

- Store event payload schemas in a centralized registry
- Enforce additive-only schema evolution on pull requests
- Detect breaking changes before they are merged
- Maintain deprecation warnings for older versions

## Registry Format

The registry lives in `docs/event-schema.json`.

Each event entry includes:

- `title`: Human-readable event name
- `description`: Optional event description
- `versions`: Array of versions, each with:
  - `version`: Semantic version string
  - `deprecated`: optional boolean
  - `description`: optional text
  - `schema`: JSON schema for the payload

## Key Rules

- Existing schema versions must never be modified after release
- New versions may be added only if they are backward compatible
- New optional fields are allowed
- New required fields on existing versions are not allowed
- `additionalProperties` may be restricted only with caution

## Validation

A CI check runs on every pull request:

- Compares the branch registry against the base branch registry
- Validates the registry format
- Fails the PR if any event or existing version was removed or mutated
- Warns when deprecated versions are still present

## Usage

Run locally:

```bash
npm run check-event-schemas
```

This command validates `docs/event-schema.json` and reports compatibility issues.
