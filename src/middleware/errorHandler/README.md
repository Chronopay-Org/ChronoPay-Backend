# Global Error Handling Middleware

Production-grade error handling for ChronoPay API with secure, tested, and documented implementations.

## Features

- **Structured Error Responses**: Consistent JSON error format across all endpoints
- **Custom Error Classes**: HTTP-specific error types (400, 401, 403, 404, 409, 422, 500, 503)
- **Security**: Internal error details hidden in production, stack traces only in development
- **Logging**: Configurable error logging with support for external logging systems
- **Type Safety**: Full TypeScript support with type guards
- **Async Handler**: Wrapper for async route handlers to automatically catch errors
- **404 Handling**: Automatic handling of unmatched routes

## Installation

The middleware is part of the ChronoPay backend codebase. No additional installation required.

## Usage

### Basic Setup

```typescript
import express from "express";
import { errorHandler, notFoundMiddleware } from "./middleware/errorHandler.js";

const app = express();

// ... your routes ...

// Add 404 handler for unmatched routes
app.use(notFoundMiddleware);

// Add global error handler
app.use(errorHandler);
```

### Using Custom Error Classes

```typescript
import { BadRequestError, NotFoundError, UnauthorizedError } from "./errors/AppError.js";

// In your route handlers
app.get("/users/:id", (req, res) => {
  const user = getUser(req.params.id);
  if (!user) {
    throw new NotFoundError(`User ${req.params.id} not found`);
  }
  res.json(user);
});

app.post("/api/data", (req, res) => {
  if (!req.body.name) {
    throw new BadRequestError("Name is required");
  }
  // ... process request
});
```

### Using Async Handler

```typescript
import { asyncErrorHandler } from "./middleware/errorHandler.js";

app.get(
  "/api/users",
  asyncErrorHandler(async (req, res) => {
    const users = await fetchUsers();
    res.json(users);
  })
);
```

### Custom Configuration

```typescript
import { createErrorHandler } from "./middleware/errorHandler.js";

const errorHandler = createErrorHandler({
  // Custom logging function
  logError: (error, req) => {
    myLogger.error({
      message: error.message,
      stack: error.stack,
      path: req.path,
      method: req.method,
    });
  },
  // Include stack trace in responses (default: development only)
  includeStackTrace: true,
  // Custom message for unknown errors
  unknownErrorMessage: "Something went wrong",
});

app.use(errorHandler);
```

## Error Response Format

All error responses follow a consistent structure:

```json
{
  "success": false,
  "error": {
    "message": "Error message",
    "code": "ERROR_CODE",
    "timestamp": "2024-01-01T00:00:00.000Z"
  }
}
```

In development, stack traces may be included:

```json
{
  "success": false,
  "error": {
    "message": "Error message",
    "code": "ERROR_CODE",
    "timestamp": "2024-01-01T00:00:00.000Z",
    "stack": "Error stack trace..."
  }
}
```

## Available Error Classes

| Error Class | Status Code | Use Case |
|------------|-------------|----------|
| `AppError` | 500 | Base error class |
| `BadRequestError` | 400 | Invalid inputs, missing fields |
| `UnauthorizedError` | 401 | Missing or invalid authentication |
| `ForbiddenError` | 403 | Insufficient permissions |
| `NotFoundError` | 404 | Resource not found |
| `ConflictError` | 409 | Resource conflicts |
| `UnprocessableEntityError` | 422 | Validation errors |
| `InternalServerError` | 500 | Unexpected server errors |
| `ServiceUnavailableError` | 503 | Temporary service issues |

## Security Considerations

1. **Production Safety**: Internal error details and stack traces are hidden in production
2. **Operational Errors**: Custom errors with `isOperational=true` are safe to expose to clients
3. **Non-Operational Errors**: Unexpected errors (e.g., database connection failures) are logged but clients receive generic messages

## Testing

Run tests with:

```bash
npm test
```

Test coverage includes:
- All custom error classes
- Middleware behavior with different error types
- Edge cases (null errors, string errors, non-error objects)
- 404 handling
- Async error handling
- Custom configuration options

## Integration with Express

The middleware should be registered last in the middleware chain:

```typescript
app.use(cors());
app.use(express.json());
// ... other middleware ...
// ... your routes ...
app.use(notFoundMiddleware);  // Must be before error handler
app.use(errorHandler);          // Must be last
```
