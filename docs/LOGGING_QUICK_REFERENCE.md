# Logging Quick Reference

## Common Use Cases

### Log a Simple Message
```typescript
import { logInfo } from './utils/logger.js';

logInfo('Operation completed');
```

### Log with Context
```typescript
import { logInfo } from './utils/logger.js';

logInfo('User updated profile', {
  userId: '123',
  fields: ['name', 'email']
});
```

### Log an Error
```typescript
import { logError } from './utils/logger.js';

try {
  await riskyOperation();
} catch (error) {
  logError('Operation failed', {
    operation: 'riskyOperation',
    error: error.message
  });
}
```

### Create Module Logger
```typescript
import { createScopedLogger } from './utils/logUtils.js';

const paymentLogger = createScopedLogger('payment-service');
paymentLogger.info('Payment processed');
```

### Time an Operation
```typescript
import { PerformanceTimer } from './utils/logUtils.js';

const timer = new PerformanceTimer('database-query');
await db.query(sql);
timer.end('Query completed');
```

### Log API Calls
```typescript
import { logApiCall } from './utils/logUtils.js';

logApiCall('GET', '/api/v1/users', 200, 45);
```

### Log Security Events
```typescript
import { logSecurityEvent } from './utils/logUtils.js';

logSecurityEvent('LOGIN_SUCCESS', userId, true, {
  ip: req.ip,
  method: 'password'
});
```

### Log Database Operations
```typescript
import { logDbOperation } from './utils/logUtils.js';

logDbOperation('SELECT', 'users', 12, 50);
```

### Log External Service Calls
```typescript
import { logExternalCall } from './utils/logUtils.js';

try {
  const result = await externalApi.call();
  logExternalCall('ExternalAPI', '/endpoint', true, 250, 200);
} catch (error) {
  logExternalCall('ExternalAPI', '/endpoint', false, 1000, 500, error);
}
```

### Detect Slow Operations
```typescript
import { logSlowOperation } from './utils/logUtils.js';

const start = Date.now();
// ... operation ...
const duration = Date.now() - start;

logSlowOperation('complex-calculation', duration, 1000);
```

### Wrap Async Function
```typescript
import { withPerformanceLogging } from './utils/logUtils.js';

const result = await withPerformanceLogging(
  async () => await processData(data),
  'data-processing',
  { dataSize: data.length }
);
```

### Batch Logging
```typescript
import { logBatch } from './utils/logUtils.js';

logBatch([
  { level: 'info', message: 'Batch started' },
  { level: 'info', message: 'Processing items' },
  { level: 'info', message: 'Batch completed' }
]);
```

## Log Levels

| Level   | Use Case                          | Example                          |
|---------|-----------------------------------|----------------------------------|
| `fatal` | Service must stop                 | Database unreachable             |
| `error` | Operation failed                  | Payment gateway timeout          |
| `warn`  | Recoverable issue                 | Rate limit approaching           |
| `info`  | Normal operation (default)        | User logged in                   |
| `debug` | Diagnostic info                   | SQL query executed               |
| `trace` | Fine-grained debugging            | Function entry/exit              |

## Environment Behavior

| Environment  | Log Level | Format         | Notes                    |
|--------------|-----------|----------------|--------------------------|
| Development  | debug     | Pretty-printed | Colors, human-readable   |
| Production   | info      | JSON           | Optimized for aggregation|
| Test         | fatal     | JSON           | Suppresses most logs     |

## Security

### Automatically Sanitized Fields
- password
- secret
- token
- apiKey / api_key
- authorization / Authorization
- cookie
- session
- privateKey / private_key

### Example
```typescript
// This is safe - password will be masked
logInfo('Login attempt', {
  username: 'john',
  password: 'secret123'  // → "se***23"
});
```

## Best Practices

✅ DO:
- Use appropriate log levels
- Include relevant context
- Use child loggers for modules
- Trust automatic sanitization
- Add request IDs for tracing

❌ DON'T:
- Log sensitive data unnecessarily
- Use console.log
- Log in tight loops
- Ignore errors
- Log massive objects

## Testing

Tests automatically suppress logs:

```bash
npm test
```

No special handling needed - just write your tests normally.

## Troubleshooting

### No Logs Appearing
- Check NODE_ENV
- Verify import path
- Ensure correct log level

### Too Much Output
- Increase log level in production
- Reduce debug/trace logging
- Use conditional logging

### Performance Concerns
- Logging adds <1ms per request
- Safe for production use
- Avoid logging in tight loops

## More Info

See [LOGGING.md](./LOGGING.md) for complete documentation.
