# CORS Allowlist Configuration Guide

## Overview

ChronoPay-Backend implements production-grade CORS (Cross-Origin Resource Sharing) configuration with secure allowlist-based validation. This replaces the permissive default `cors()` middleware with a configurable, security-focused solution.

## Features

- **Secure by default**: No origins are allowed until explicitly configured
- **Allowlist validation**: Only configured origins can access the API
- **Wildcard pattern support**: Support for subdomain patterns (e.g., `https://*.example.com`)
- **Environment-based configuration**: Different configs for development, staging, and production
- **Credentials support**: Configurable credential handling for cross-origin requests
- **Comprehensive validation**: Origin validation with security constraints
- **Production-tested**: Designed for enterprise deployments

## Configuration

### Environment Variables

CORS configuration is loaded from environment variables:

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `CORS_ALLOWED_ORIGINS` | Comma-separated list of allowed origins | See below | `https://example.com, https://*.example.com` |
| `CORS_ALLOWED_METHODS` | Comma-separated HTTP methods | `GET,POST,PUT,DELETE,PATCH,OPTIONS` | `GET, POST` |
| `CORS_ALLOWED_HEADERS` | Comma-separated request headers | `Content-Type,Authorization` | `Content-Type, X-Custom-Header` |
| `CORS_ALLOW_CREDENTIALS` | Allow credentials (cookies, etc.) | `true` | `false` |
| `CORS_MAX_AGE` | Preflight cache duration (seconds) | `86400` | `3600` |
| `NODE_ENV` | Environment (development/staging/production) | `development` | `production` |

### Default Configuration

**Development/Staging (NODE_ENV != "production")**:
```
- http://localhost:3000
- http://localhost:3001
```

**Production**:
- Empty by default (must be explicitly configured via environment variables)

### Example Configuration

#### Development
```bash
# Uses defaults - no configuration needed
NODE_ENV=development
```

#### Production
```bash
NODE_ENV=production
CORS_ALLOWED_ORIGINS=https://app.chronopay.com,https://*.chronopay.com
CORS_ALLOW_CREDENTIALS=true
CORS_MAX_AGE=86400
```

#### Staging
```bash
NODE_ENV=staging
CORS_ALLOWED_ORIGINS=https://staging.chronopay.com,https://localhost:3000
CORS_ALLOWED_METHODS=GET,POST,PUT,DELETE,PATCH,OPTIONS
CORS_ALLOWED_HEADERS=Content-Type,Authorization,X-Request-ID
```

## Origin Matching Rules

### Exact Matches
Exact origin strings are matched as-is:
- `https://example.com` matches exactly `https://example.com`
- Does NOT match `https://app.example.com` or `https://example.com:8443`

### Wildcard Patterns
Wildcard patterns support dynamic subdomains:
- `https://*.example.com` matches `https://app.example.com` and `https://sub.app.example.com`
- Does NOT match `https://example.com` (base domain is not matched)
- Does NOT match `https://example.org` (top-level domain is locked)

### Security Constraints
- Wildcard-only patterns (`*`) are rejected for security
- Multiple wildcards per pattern are rejected
- Wildcards must be followed by a dot (prevents `*.com` style matches)
- All origins must be valid URLs (scheme + domain at minimum)
- Port numbers must match exactly

## Security Considerations

### Design Assumptions

1. **Origin Header Trust**: The implementation assumes the `Origin` header is trustworthy. In practice, browsers always send this for CORS requests, but server-side validation is still essential.

2. **HTTPS Production**: Production deployments should use HTTPS schemes only. Avoid `http://` URLs in production.

3. **Credential Isolation**: When `CORS_ALLOW_CREDENTIALS=true`, the `Access-Control-Allow-Origin` header is set to the specific origin (not `*`), preventing credential leakage.

4. **Preflight Caching**: The `maxAge` setting controls how long browsers cache preflight results. Higher values reduce requests but prevent quick updates.

### Failure Modes

#### Empty Allowlist
- When `CORS_ALLOWED_ORIGINS` is empty in production, no origins are allowed
- Result: All CORS requests are rejected
- Mitigation: Explicitly configure allowed origins in production

#### Invalid Origin Header
- Origins that don't parse as valid URLs are rejected
- Result: Request processed without CORS headers
- Mitigation: None needed - feature is working correctly

#### Pattern Mismatch
- Origins that don't match any pattern in the allowlist are rejected
- Result: Request processed without CORS headers
- Mitigation: Verify origin list matches your deployment domains

#### Wildcard Misconfig
- Invalid wildcard patterns (e.g., `*.com`, `*.*.example.com`) are caught during validation
- Result: Server startup fails with clear error message
- Mitigation: Use proper wildcard syntax: `https://*.example.com`

## Implementation Details

### Configuration Loading (`src/config/cors.ts`)

The `getCORSConfig()` function:
1. Detects the NODE_ENV environment variable
2. Loads production-specific defaults for `production`
3. Loads development defaults otherwise
4. Overrides with environment variables if provided
5. Parses CSV lists and boolean/numeric values

### Origin Validation (`src/config/cors.ts`)

The `isOriginAllowed()` function:
1. Validates origin exists and is a non-empty string
2. Validates origin is a well-formed URL
3. Checks for exact match in allowlist
4. Checks for wildcard pattern match
5. Returns boolean result

### Middleware (`src/middleware/cors.ts`)

The `createCORSMiddleware()` function:
1. Checks if origin is in allowlist
2. For allowed origins: Sets all CORS headers
3. For disallowed origins: Only processes request without CORS headers
4. Handles OPTIONS (preflight) requests specially
5. Returns 403 for disallowed preflight requests

## Testing

Comprehensive test coverage includes:
- Origin validation (exact matches, patterns, wildcards)
- Configuration loading from environment variables
- Preflight request handling
- Credentials handling
- Edge cases (empty lists, invalid URLs, missing headers)
- Security constraint validation

Run tests with:
```bash
npm test -- src/__tests__/cors.test.ts
```

Target coverage: **≥95%**

## API Reference

### Configuration Functions

#### `getCORSConfig(): CORSConfig`
Loads CORS configuration from environment variables and NODE_ENV.

**Returns**: `CORSConfig` object with loaded configuration

#### `validateCORSConfig(config: CORSConfig): boolean`
Validates CORS configuration and throws errors for invalid configs.

**Parameters**:
- `config`: CORSConfig object to validate

**Returns**: `true` if valid

**Throws**: Error if configuration is invalid

#### `isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean`
Checks if an origin is allowed based on the allowlist.

**Parameters**:
- `origin`: Origin header from request
- `allowedOrigins`: List of allowed origins and patterns

**Returns**: `true` if allowed, `false` otherwise

### Middleware Functions

#### `createCORSMiddleware(config: CORSConfig): Middleware`
Creates an Express middleware for CORS validation.

**Parameters**:
- `config`: CORSConfig object from `getCORSConfig()`

**Returns**: Express middleware function

**Behavior**:
- Validates origin against allowlist
- Sets CORS headers for allowed origins
- Returns 403 for disallowed preflight requests

## Troubleshooting

### CORS errors in browser console
**Symptom**: "Access to XMLHttpRequest has been blocked by CORS policy"

**Causes**:
1. Origin not in allowlist
2. Invalid wildcard patterns
3. Mismatched port numbers
4. HTTP vs HTTPS mismatch

**Solution**: Check `CORS_ALLOWED_ORIGINS` and verify your domain matches exactly.

### Preflight failures
**Symptom**: OPTIONS request returns 403

**Causes**:
1. Origin not in allowlist
2. Preflight request sent without Origin header

**Solution**: Ensure origin is in allowlist and properly formatted.

### Configuration not loading
**Symptom**: Origin is allowed unexpectedly or not allowed as expected

**Causes**:
1. Environment variable not set
2. Syntax error in CSV list (missing comma)
3. Whitespace in origin strings

**Solution**: Verify environment variables are set correctly (check with `echo $VARIABLE_NAME`).

### Server startup fails
**Symptom**: "Invalid CORS configuration" error on startup

**Causes**:
1. Wildcard-only pattern (`*`)
2. Invalid URL in allowlist
3. Invalid maxAge value

**Solution**: Check error message and review configuration.

## Commit Message Guidelines

When committing CORS-related changes:

```
feat(cors): implement allowlist configuration

- Add CORS configuration module with environment-based settings
- Create CORS middleware for origin validation
- Support wildcard patterns for flexible subdomain matching
- Replace permissive default cors() with secure allowlist validation
- Include 95%+ test coverage
```

## References

- [MDN CORS Documentation](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS)
- [OWASP CORS Best Practices](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Origin_Resource_Sharing_Cheat_Sheet.html)
- [Express CORS Documentation](https://expressjs.com/en/resources/middleware/cors.html)
