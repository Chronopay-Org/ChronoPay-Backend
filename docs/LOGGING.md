# Structured JSON Logging Guide

## Overview

ChronoPay Backend uses **pino**, a high-performance JSON logging library, for production-grade structured logging. This guide covers implementation details, usage patterns, and best practices.

## Features

- **Structured JSON Output**: Machine-readable logs optimized for log aggregation systems
- **Automatic Request Logging**: HTTP request/response logging with timing and metadata
- **Security-First**: Automatic sanitization of sensitive data (passwords, tokens, API keys)
- **Performance Tracking**: Built-in utilities for measuring operation duration
- **Environment-Aware**: Different log levels and formats for development/production/test
- **Error Serialization**: Comprehensive error tracking with stack traces and causes
- **Request ID Tracking**: Distributed tracing support via request correlation IDs
- **Standardized Log Fields**: Consistent fields across all middleware (requestId, route, method, status, duration, userId, apiKeyId)

## Installation

Logging dependencies are included in `package.json`:

```json
{
  "dependencies": {
    "pino": "^9.6.0",
    "pino-http": "^10.4.0",
    "pino-pretty": "^13.0.0"
  }
}
```

## Quick Start

### Basic Logging

```typescript
import { logger } from './utils/logger.js';

// Log at different levels
logger.info('User logged in');
logger.warn('Rate limit approaching');
logger.error({ error }, 'Database connection failed');
```

### Logging with Context

```typescript
import { logInfo, logError } from './utils/logger.js';

// Add context to your logs
logInfo('Payment processed', {
  userId: 'user-123',
  amount: 99.99,
  currency: 'USD'
});

logError('Payment failed', {
  userId: 'user-456',
  errorCode: 'INSUFFICIENT_FUNDS'
});
```

### Child Loggers

```typescript
import { createChildLogger } from './utils/logger.js';

// Create module-specific loggers
const authLogger = createChildLogger({
  module: 'authentication',
  requestId: 'req-789'
});

authLogger.info('Token validated');
```

## Log Levels

| Level   | When to Use                                      | Example                                    |
|---------|--------------------------------------------------|--------------------------------------------|
| `fatal` | Service termination required                     | Unrecoverable database connection loss     |
| `error` | Critical failures, external API errors          | Payment gateway timeout                    |
| `warn`  | Recoverable issues, deprecated API usage        | Rate limit warning                         |
| `info`  | Normal operations (default level in production) | User login, payment completed              |
| `debug` | Detailed diagnostic information                 | Query execution details                    |
| `trace` | Fine-grained debugging                          | Function entry/exit points                 |

## Environment Configuration

### Development (NODE_ENV=development)

- **Log Level**: `debug`
- **Format**: Pretty-printed with colors
- **Features**: Human-readable output

Example output:
```
[12:34:56.789] INFO (chronopay-backend): User logged in
    service: "chronopay-backend"
    version: "0.1.0"
    environment: "development"
    userId: "user-123"
```

### Production (NODE_ENV=production)

- **Log Level**: `info`
- **Format**: Raw JSON
- **Features**: Optimized for log aggregation (Datadog, Splunk, CloudWatch)

Example output:
```json
{"level":"INFO","time":"2026-03-24T12:34:56.789Z","pid":123,"hostname":"server-1","service":"chronopay-backend","version":"0.1.0","environment":"production","userId":"user-123","msg":"User logged in"}
```

### Test (NODE_ENV=test)

- **Log Level**: `fatal` (suppresses most logs)
- **Format**: Raw JSON
- **Features**: Minimal output to avoid test noise

## Security Features

### Automatic Data Sanitization

The logger automatically sanitizes sensitive fields:

```typescript
// These fields are automatically masked
const sensitiveData = {
  password: 'secret123',      // → "se***123"
  token: 'eyJhbGciOiJ...',    // → "ey***J9"
  apiKey: 'sk_test_abc123',   // → "sk***23"
  authorization: 'Bearer ...'  // → "[REDACTED]"
};

logger.info(sensitiveData, 'Login attempt');
```

**Sanitized Fields:**
- `password`
- `secret`
- `token`
- `apiKey` / `api_key`
- `authorization` / `Authorization`
- `cookie`
- `session`
- `privateKey` / `private_key`

### Redaction Rules

Complete redaction (field removed entirely) for:
- `headers.authorization`
- `headers.cookie`
- `req.headers.authorization`
- `req.headers.cookie`
- `body.password`
- `body.secret`
- `query.token`

## HTTP Request Logging

All HTTP requests are automatically logged with standardized fields:

| Field | Type | Description |
|-------|------|-------------|
| `requestId` | string | Unique request identifier (auto-generated or from `x-request-id` header) |
| `route` | string | Route pattern (path parameters sanitized, e.g., `/users/:id` → `/users/:REDACTED`) |
| `method` | string | HTTP method (GET, POST, etc.) |
| `status` | number | HTTP status code |
| `duration` | number | Request processing time in milliseconds |
| `userId` | string? | Authenticated user ID (if available) |
| `apiKeyId` | string? | API key identifier (if used) |
| `ip` | string? | Client IP address |
| `userAgent` | string? | Client user agent |

### Identity Fields

Identity fields (`userId`, `apiKeyId`) are populated from:
1. Auth middleware (via `x-chronopay-user-id` header)
2. API key middleware (via `x-api-key` header)
3. Custom `x-api-key-id` header

**Security**: Sensitive data (tokens, emails, passwords) are NEVER logged. Only stable, non-sensitive identifiers are included.

### Example Request Log

```json
{
  "level": "INFO",
  "time": "2026-03-24T12:34:56.789Z",
  "requestId": "req_1234567890_abc",
  "route": "/api/v1/payment",
  "method": "POST",
  "status": 201,
  "duration": 145,
  "userId": "user-123",
  "ip": "192.168.1.100",
  "userAgent": "Mozilla/5.0...",
  "msg": "POST /api/v1/payment completed in 145ms [201]"
}
```

### Custom Request Attributes

The middleware adds custom attributes to all request logs:

- `duration_ms`: Request processing time in milliseconds
- `user_agent`: Client user agent string
- `protocol`: HTTP version
- `ip`: Client IP address
- `timestamp`: ISO 8601 timestamp

## Utility Functions

### Performance Timer

Measure operation duration:

```typescript
import { PerformanceTimer } from './utils/logUtils.js';

const timer = new PerformanceTimer('database-query', { queryId: 'q-123' });

try {
  // Your operation
  await db.query('SELECT * FROM users');
  timer.end('Query completed');
} catch (error) {
  timer.endWithError(error, 'Query failed');
}
```

### Scoped Logger

Create module-specific loggers:

```typescript
import { createScopedLogger } from './utils/logUtils.js';

const paymentLogger = createScopedLogger('payment-service', {
  environment: 'production'
});

paymentLogger.info('Payment initialized');
```

### API Call Logging

Standardized API call logging:

```typescript
import { logApiCall } from './utils/logUtils.js';

logApiCall('GET', '/api/v1/slots', 200, 45, {
  userId: 'user-123'
});
// Output: "API GET /api/v1/slots [200]"
```

### Database Operation Logging

Track database queries:

```typescript
import { logDbOperation } from './utils/logUtils.js';

logDbOperation('SELECT', 'users', 15, 100, {
  queryId: 'q-456'
});
// Output: "DB SELECT on users in 15ms"
```

## Log Context Builder

Use the log context builder for standardized fields across middleware:

```typescript
import {
  buildRequestLogContext,
  addIdentityToContext,
  addResponseData,
  extractIdentity
} from './utils/logContext.js';

// Build base context from request
const context = buildRequestLogContext(req);

// Add identity (userId or apiKeyId)
const identity = extractIdentity(req);
const contextWithIdentity = addIdentityToContext(context, identity);

// Add response data
const finalContext = addResponseData(contextWithIdentity, res.statusCode, duration);

// Result includes: requestId, route, method, status, duration, userId, apiKeyId, ip, userAgent
```

### Route Sanitization

Route parameters are automatically sanitized to prevent sensitive data in logs:
- `/users/:id` → `/users/:REDACTED`
- `/payments/:paymentId/refund` → `/payments/:REDACTED/refund`

### Security Notes

- **NEVER log**: tokens, emails, passwords, phone numbers, API keys (values)
- **SAFE to log**: user IDs, API key IDs (identifiers only), IP addresses, user agents
- Identity fields are populated from auth middleware automatically

### External Call Logging

Monitor third-party API calls:

```typescript
import { logExternalCall } from './utils/logUtils.js';

try {
  const result = await stellarHorizon.submitTransaction(tx);
  logExternalCall('Stellar Horizon', '/submit', true, 250, 200);
} catch (error) {
  logExternalCall('Stellar Horizon', '/submit', false, 5000, 503, error);
}
```

### Security Event Logging

Audit trail for security events:

```typescript
import { logSecurityEvent } from './utils/logUtils.js';

logSecurityEvent('AUTH_SUCCESS', 'user-123', true, {
  ip: '192.168.1.100',
  method: 'oauth'
});

logSecurityEvent('ACCESS_DENIED', 'user-456', false, {
  resource: '/admin'
});
```

### Slow Operation Detection

Automatically detect slow operations:

```typescript
import { logSlowOperation } from './utils/logUtils.js';

const startTime = Date.now();
// ... operation ...
const duration = Date.now() - startTime;

logSlowOperation('complex-query', duration, 1000, {
  queryType: 'aggregation'
});
// Only logs if duration > threshold (1000ms default)
```

### Batch Logging

Group related log entries:

```typescript
import { logBatch } from './utils/logUtils.js';

logBatch([
  { level: 'info', message: 'Batch started', context: { count: 100 } },
  { level: 'info', message: 'Processing items' },
  { level: 'warn', message: 'Some items failed' },
  { level: 'info', message: 'Batch completed' }
]);
```

### Performance Wrapper

Automatically wrap async functions with timing:

```typescript
import { withPerformanceLogging } from './utils/logUtils.js';

const result = await withPerformanceLogging(
  async () => {
    // Your async operation
    return await processData(data);
  },
  'data-processing',
  { dataSize: data.length }
);
```

## Middleware Integration

### Request Logger Middleware

Automatically applied in `src/index.ts`:

```typescript
import { createRequestLogger } from './middleware/requestLogger.js';

app.use(createRequestLogger());
```

**Features:**
- Automatic request/response logging
- Dynamic log levels based on status codes:
  - 2xx → `info`
  - 4xx → `warn`
  - 5xx → `error`
- Health check filtering in production
- Request ID generation/tracking
- Response time tracking
- Slow request detection (>5 seconds)

### Error Logger Middleware

Capture unhandled errors:

```typescript
import { errorLoggerMiddleware } from './middleware/requestLogger.js';

app.use(errorLoggerMiddleware);
```

**Logs include:**
- Full error details (name, message, stack, code)
- Request context (headers, body, query, params)
- Response status
- Request duration

## Best Practices

### DO ✅

- **Use appropriate log levels**: Choose the level that matches the severity
- **Include context**: Add relevant metadata to help debugging
- **Use child loggers**: Create module-specific loggers for better organization
- **Leverage utilities**: Use `logApiCall`, `logDbOperation`, etc. for consistency
- **Trust automatic sanitization**: Don't manually mask sensitive data
- **Add request IDs**: Use `x-request-id` header for distributed tracing

### DON'T ❌

- **Don't log sensitive data**: Even though it's sanitized, avoid logging it at all
- **Don't use console.log**: Always use the logger
- **Don't log in tight loops**: Use debug/trace levels sparingly in performance-critical code
- **Don't ignore errors**: Always log errors with full context
- **Don't log large objects**: Be selective about what you include

## Testing

Tests run with `NODE_ENV=test` which suppresses most logs:

```bash
npm test
```

The logging system is designed to be non-intrusive during testing while still allowing you to verify logging behavior when needed.

## Monitoring and Alerting

### Slow Request Alerts

Requests taking longer than 5 seconds trigger warning logs:

```json
{
  "level": "WARN",
  "alert_type": "slow_request",
  "duration_ms": 5234,
  "url": "/api/v1/slow-endpoint",
  "request_id": "req_123"
}
```

### Error Rate Monitoring

All errors are logged with `error` level, making it easy to set up alerts in your log aggregation system based on error frequency.

## Troubleshooting

### No Logs Appearing

- Check `NODE_ENV` setting
- Verify log level configuration
- Ensure logger is imported correctly

### Sensitive Data Still Visible

- Review the `sensitiveFields` array in `logger.ts`
- Add custom fields to the redaction list
- Never rely solely on automatic sanitization - avoid logging sensitive data

### Performance Issues

- Reduce logging in hot paths
- Use lower log levels in production
- Consider sampling for very high-volume endpoints

## Architecture

### File Structure

```
src/
├── utils/
│   ├── logger.ts          # Core logger configuration
│   └── logUtils.ts        # Logging utilities
├── middleware/
│   └── requestLogger.ts   # HTTP request logging middleware
└── __tests__/
    ├── logger.unit.test.ts
    ├── logUtils.unit.test.ts
    └── health.test.ts
```

### Dependencies

- **pino**: Core logging library (fast, low-overhead)
- **pino-http**: HTTP request logging middleware
- **pino-pretty**: Development-time log formatting

## Configuration Options

Environment variables:

- `NODE_ENV`: Controls log level and format (`development`, `production`, `test`)
- `SERVICE_NAME`: Service identifier (default: `chronopay-backend`)
- `SERVICE_VERSION`: Service version (default: `0.1.0`)
- `HOSTNAME`: Server hostname (auto-detected if not set)

## Support

For questions or issues related to logging:

1. Check this documentation
2. Review the test files for examples
3. Consult the pino documentation: https://getpino.io

---

**Version**: 1.0.0  
**Last Updated**: March 24, 2026  
**Maintainer**: ChronoPay Backend Team
