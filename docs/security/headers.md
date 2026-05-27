# Security Headers Baseline

## Overview

This document describes the baseline security headers applied to all API responses. These headers provide defense-in-depth protection against common web vulnerabilities while maintaining API functionality.

## Headers Applied

### X-Content-Type-Options: nosniff

**Purpose:** Prevent MIME type sniffing attacks

**Value:** `nosniff`

**Behavior:** Instructs browsers to strictly respect the `Content-Type` header and not attempt to guess the content type. This prevents attackers from uploading files with misleading MIME types.

**Browser Support:** All modern browsers

### X-Frame-Options: DENY

**Purpose:** Prevent clickjacking attacks

**Value:** `DENY`

**Behavior:** Prevents the API responses from being embedded in frames on other websites. This protects against clickjacking attacks where users are tricked into clicking on hidden elements.

**Options:**

- `DENY`: Page cannot be displayed in a frame
- `SAMEORIGIN`: Page can only be displayed in a frame on the same origin
- `ALLOW-FROM uri`: Page can only be displayed in a frame on the specified origin (deprecated)

**Browser Support:** All modern browsers

### Referrer-Policy: strict-origin-when-cross-origin

**Purpose:** Control referrer information leakage

**Value:** `strict-origin-when-cross-origin`

**Behavior:** Sends the full URL as referrer for same-origin requests, but only the origin for cross-origin requests. This balances privacy with functionality.

**Options:**

- `no-referrer`: Never send referrer
- `no-referrer-when-downgrade`: Send referrer only for same-security-level requests
- `same-origin`: Send referrer only for same-origin requests
- `origin`: Send only the origin
- `strict-origin`: Send only origin, never for downgrade
- `origin-when-cross-origin`: Send full URL for same-origin, origin for cross-origin
- `strict-origin-when-cross-origin`: Send full URL for same-origin, origin for cross-origin (no downgrade)
- `unsafe-url`: Always send full URL

**Browser Support:** All modern browsers

### Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=()

**Purpose:** Disable unnecessary browser APIs

**Value:** `geolocation=(), microphone=(), camera=(), payment=()`

**Behavior:** Explicitly disables access to sensitive browser APIs that are not needed for API functionality. This prevents malicious scripts from accessing these features.

**Disabled APIs:**

- `geolocation`: Location services
- `microphone`: Microphone access
- `camera`: Camera access
- `payment`: Payment Request API

**Browser Support:** Modern browsers (Chrome 74+, Edge 79+, Firefox 74+)

### Content-Security-Policy (Optional)

**Purpose:** Prevent injection attacks

**Default:** Disabled (can be enabled for documentation serving)

**When to Enable:** If serving Swagger UI or other HTML documentation

**Default Directives (when enabled):**

```
default-src 'self'
script-src 'self' 'unsafe-inline'
style-src 'self' 'unsafe-inline'
img-src 'self' data: https:
font-src 'self' data:
connect-src 'self'
frame-ancestors 'none'
base-uri 'self'
form-action 'self'
```

**Notes:**

- `'unsafe-inline'` is required for Swagger UI
- Can be customized per environment
- Stricter policies recommended for production

## Implementation

### Middleware

The security headers are applied via the `securityHeaders` middleware in `src/middleware/securityHeaders.ts`.

### Usage

```typescript
import { securityHeaders } from "./middleware/securityHeaders.js";

app.use(securityHeaders);
```

### Configuration

```typescript
import { createSecurityHeaders } from "./middleware/securityHeaders.js";

const customHeaders = createSecurityHeaders({
  enableCSP: true,
  cspDirectives: {
    "script-src": "'self' https://cdn.example.com",
  },
  enableFrameOptions: true,
  enableReferrerPolicy: true,
  enablePermissionsPolicy: true,
});

app.use(customHeaders);
```

## Security Considerations

### Defense in Depth

These headers provide multiple layers of protection:

1. **MIME Type Sniffing:** X-Content-Type-Options prevents browser confusion
2. **Clickjacking:** X-Frame-Options prevents embedding in frames
3. **Referrer Leakage:** Referrer-Policy controls information disclosure
4. **API Abuse:** Permissions-Policy disables unnecessary features
5. **Injection Attacks:** CSP (when enabled) prevents script injection

### Browser Compatibility

All headers are supported by modern browsers. Older browsers will safely ignore unsupported headers.

### Performance Impact

Security headers have negligible performance impact:

- Headers are small (< 1KB total)
- No additional processing required
- No network overhead

## Testing

### Verify Headers

```bash
curl -I http://localhost:3001/api/v1/slots
```

Expected output:

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=()
```

### Automated Testing

Run security header tests:

```bash
npm test -- src/__tests__/security-headers.test.ts
```

## References

- [MDN: X-Content-Type-Options](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Content-Type-Options)
- [MDN: X-Frame-Options](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Frame-Options)
- [MDN: Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referrer-Policy)
- [MDN: Permissions-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Permissions-Policy)
- [MDN: Content-Security-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy)
- [OWASP: Security Headers](https://owasp.org/www-project-secure-headers/)

## Changelog

### Version 1.0.0

- Initial implementation
- Added X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy
- Optional CSP support for documentation serving
- Comprehensive test coverage
