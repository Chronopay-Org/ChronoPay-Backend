# Environment Variable Schema Validation

## Overview

ChronoPay validates environment variables centrally in `src/config/env.ts` before the application starts serving requests.

## Where validation occurs

- `loadEnvConfig()` parses and validates `process.env`
- `src/index.ts` calls it during startup
- invalid configuration throws `EnvValidationError` immediately

## Variables covered

Current `src` usage requires these variables:

- `NODE_ENV`
- `PORT`
- `REDIS_URL`

## Defaults and constraints

- `NODE_ENV`
  - optional
  - defaults to `development`
  - allowed values: `development`, `test`, `production`
- `PORT`
  - optional
  - defaults to `3001`
  - must be a whole number between `1` and `65535`
- `REDIS_URL`
  - required
  - must be a valid URL
  - allowed schemes: `redis`, `rediss`
  - host is required
  - must not contain embedded credentials
  - whitespace-only values are rejected

Whitespace-only values are rejected rather than treated as valid.

## Failure behavior

Startup fails fast with a sanitized aggregated error message like:

```text
Invalid environment configuration:
- NODE_ENV must be one of: development, test, production.
- PORT must be a whole number between 1 and 65535.
```

The message includes variable names and reasons, but never echoes raw values.

## Threat Model Considerations

- **Secret Leakage**: Validation errors never include raw environment variable values to prevent accidental exposure of secrets like API keys or database credentials.
- **Misconfiguration Masking**: Errors are aggregated and provide specific reasons without revealing internal parsing details that could aid attackers in crafting bypass attempts.
- **Embedded Credentials**: REDIS_URL validation rejects URLs containing username/password to prevent secrets from being stored in environment variables, reducing the risk of credential exposure through logs or error messages.

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
