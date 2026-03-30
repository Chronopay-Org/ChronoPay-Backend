# Environment Variable Schema Validation

## Overview

ChronoPay validates environment variables centrally in `src/config/env.ts` before the application starts serving requests.

## Where validation occurs

- `loadEnvConfig()` parses and validates `process.env`
- `src/index.ts` calls it during startup
- invalid configuration throws `EnvValidationError` immediately

## Variables covered

Current `src` usage only requires these variables:

- `NODE_ENV`
- `PORT`

## Defaults and constraints

- `NODE_ENV`
  - optional
  - defaults to `development`
  - allowed values: `development`, `test`, `production`
- `PORT`
  - optional
  - defaults to `3001`
  - must be a whole number between `1` and `65535`

Whitespace-only values are rejected rather than treated as valid.

## Failure behavior

Startup fails fast with a sanitized aggregated error message like:

```text
Invalid environment configuration:
- NODE_ENV must be one of: development, test, production.
- PORT must be a whole number between 1 and 65535.
```

The message includes variable names and reasons, but never echoes raw values.

## Security notes

- invalid config never allows partial startup
- raw env values are not included in thrown error messages
- parsing is strict for enums and numbers
- no insecure defaults were added for missing secrets because `src` does not currently use any secret env vars

## Reviewer acceptance criteria

- env parsing is centralized in `src`
- invalid startup config throws deterministically
- defaults are documented and tested
- touched modules stay scoped to `src`
- error output is actionable and sanitized
