# Checkout Session API Documentation

## Overview

The Checkout Session API provides secure, production-grade checkout functionality for the ChronoPay platform. It enables:

- Creation of time-limited checkout sessions with payment info
- Session state management (pending → completed/failed/cancelled)
- Comprehensive input validation with detailed error handling
- Authorization and security-first design
- Full test coverage (65+ tests)

## Architecture

### Components

1. **Types** ([src/types/checkout.ts](src/types/checkout.ts))
   - Core data structures and interfaces
   - Payment methods, currencies, session status
   - Custom error handling with `CheckoutError` class

2. **Service Layer** ([src/services/checkout.ts](src/services/checkout.ts))
   - Business logic for session management
   - In-memory storage (database-ready design)
   - Session lifecycle: create, retrieve, state transitions
   - Automatic cleanup of expired sessions

3. **Middleware** ([src/middleware/checkout-validation.ts](src/middleware/checkout-validation.ts))
   - Request validation with granular error codes
   - Email format validation (RFC 5321)
   - Amount boundary validation (1 to 1 billion)
   - Currency and payment method whitelisting
   - UUID format validation for session IDs

4. **Routes** ([src/routes/checkout.ts](src/routes/checkout.ts))
   - RESTful endpoints for session management
   - Unified error handling
   - Consistent response formats

## API Endpoints

### 1. Create Checkout Session

```
POST /api/v1/checkout/sessions
```

Creates a new checkout session with payment and customer information.

**Request Body:**

```json
{
  "payment": {
    "amount": 10000,
    "currency": "USD",
    "paymentMethod": "credit_card",
    "description": "Optional description"
  },
  "customer": {
    "customerId": "cust_123abc",
    "email": "customer@example.com",
    "firstName": "John",
    "lastName": "Doe",
    "address": {
      "street": "123 Main St",
      "city": "New York",
      "state": "NY",
      "postalCode": "10001",
      "country": "US"
    }
  },
  "metadata": {
    "orderId": "ORD-12345",
    "userId": "user_123"
  },
  "successUrl": "https://example.com/success",
  "cancelUrl": "https://example.com/cancel"
}
```

**Response (201 Created):**

```json
{
  "success": true,
  "session": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "payment": {
      "amount": 10000,
      "currency": "USD",
      "paymentMethod": "credit_card",
      "description": "Optional description"
    },
    "customer": {
      "customerId": "cust_123abc",
      "email": "customer@example.com",
      "firstName": "John",
      "lastName": "Doe"
    },
    "status": "pending",
    "createdAt": 1710986400,
    "expiresAt": 1711072800,
    "updatedAt": 1710986400,
    "metadata": {
      "orderId": "ORD-12345",
      "userId": "user_123"
    },
    "successUrl": "https://example.com/success",
    "cancelUrl": "https://example.com/cancel"
  },
  "checkoutUrl": "http://localhost:3001/api/v1/checkout/sessions/550e8400-e29b-41d4-a716-446655440000/pay"
}
```

**Error Responses:**

| Status | Code | Message |
|--------|------|---------|
| 400 | `INVALID_AMOUNT` | Amount must be a positive integer (1 to 1,000,000,000) |
| 400 | `INVALID_CURRENCY` | Unsupported currency (USD, EUR, GBP, XLM) |
| 400 | `INVALID_EMAIL` | Invalid email format |
| 400 | `INVALID_CUSTOMER_ID` | Invalid customer ID format (alphanumeric, hyphens, underscores) |
| 400 | `INVALID_PAYMENT_METHOD` | Invalid payment method (credit_card, bank_transfer, crypto) |
| 400 | `MISSING_REQUIRED_FIELD` | Missing or invalid required field |
| 401 | `UNAUTHORIZED` | Authorization required (when enabled) |
| 503 | `INTERNAL_ERROR` | Session limit reached |

### 2. Get Checkout Session

```
GET /api/v1/checkout/sessions/:sessionId
```

Retrieves the current state of a checkout session.

**Path Parameters:**

- `sessionId` (UUID format): Unique session identifier

**Response (200 OK):**

```json
{
  "success": true,
  "session": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "payment": { ... },
    "customer": { ... },
    "status": "pending",
    "createdAt": 1710986400,
    "expiresAt": 1711072800,
    "updatedAt": 1710986400
  }
}
```

**Error Responses:**

| Status | Code | Message |
|--------|------|---------|
| 400 | `MISSING_REQUIRED_FIELD` | Invalid session ID format |
| 404 | `SESSION_NOT_FOUND` | Session not found |
| 410 | `SESSION_EXPIRED` | Checkout session has expired |

### 3. Complete Session

```
POST /api/v1/checkout/sessions/:sessionId/complete
```

Marks a session as completed (payment successful).

**Request Body (Optional):**

```json
{
  "paymentToken": "tok_visa_4242"
}
```

**Response (200 OK):**

```json
{
  "success": true,
  "session": {
    ...session data with status: "completed" and paymentToken...
  }
}
```

**Error Responses:**

- 404 → `SESSION_NOT_FOUND`
- 409 → `INVALID_SESSION_STATE` (not in pending state)
- 410 → `SESSION_EXPIRED`

### 4. Fail Session

```
POST /api/v1/checkout/sessions/:sessionId/fail
```

Marks a session as failed (payment failed).

**Request Body (Optional):**

```json
{
  "reason": "Card declined"
}
```

**Response (200 OK):**

Session moved to `failed` status with reason in metadata.

### 5. Cancel Session

```
POST /api/v1/checkout/sessions/:sessionId/cancel
```

Cancels a pending session (user-initiated or merchant action).

**Response (200 OK):**

Session moved to `cancelled` status.

---

## Session Status Machine

```
pending ──→ completed
   ├──→ failed
   └──→ cancelled

completed/failed/cancelled: No further transitions
```

**Rules:**

- Only `pending` sessions can transition to other states
- Transitions are idempotent: operations are safe to retry
- Expired sessions return 410 (Gone) status
- All state transitions update the `updatedAt` timestamp

---

## Data Validation Rules

### Amount Validation

- **Type**: Integer (no decimals)
- **Range**: 1 to 1,000,000,000 (smallest currency unit)
- **Examples**:
  - $100.00 USD → 10,000
  - €50.00 EUR → 5,000
  - 1.5 XLM → 1,500,000 stroops (XLM's 7 decimal places)

### Currency Support

- `USD` - US Dollar
- `EUR` - Euro
- `GBP` - British Pound
- `XLM` - Stellar Lumens (blockchain)

### Payment Methods

- `credit_card` - Credit/debit card
- `bank_transfer` - Bank transfer/ACH
- `crypto` - Cryptocurrency (Stellar-native)

### Customer ID

- **Format**: Alphanumeric with hyphens and underscores
- **Length**: 1-255 characters
- **Valid**: `cust_123`, `user-abc`, `wallet_xyz_001`
- **Invalid**: `user@123`, `cust#1`, spaces, special chars

### Email Validation

- **Standard**: RFC 5321 format
- **Max Length**: 254 characters
- **Valid**: `user@example.com`, `john.doe+tag@company.co.uk`
- **Invalid**: `invalid-email`, `user@`, `@example.com`

---

## Security Considerations

### Authorization

- Set `REQUIRE_AUTH=true` to enable bearer token validation
- Token extraction: `Authorization: Bearer <token>`
- Currently placeholder; integrate with your auth service

### Input Validation

- **Whitelist approach**: Only known values accepted
- **Boundaries**: Amount limited to prevent integer overflow
- **Email format**: RFC-compliant with length limits
- **UUID validation**: Strict format checking for session IDs

### Session Storage

- **In-memory storage**: Current implementation for development
- **Production-ready**: Service layer abstraction allows easy database swap
- **Expiration**: 24-hour TTL (configurable via `SESSION_EXPIRATION_TIME`)
- **Memory limit**: Max 10,000 sessions to prevent unbounded growth

### Rate Limiting

- Recommended: Implement at API gateway or middleware level
- Per-customer, per-IP, or global rate limits

### CORS

- Configured via [src/config/cors.ts](src/config/cors.ts)
- Allowlist-based approach
- Production mode requires explicit origin configuration

---

## Testing

### Test Coverage

- **Overall**: 90.59% statement coverage
- **Checkout middleware**: 94.64% coverage
- **Checkout service**: 89.65% coverage
- **Total tests**: 65 tests across 4 suites

### Test Categories

1. **Happy Path Tests** (35+)
   - Session creation with valid inputs
   - All state transitions
   - Metadata and optional fields

2. **Validation Tests** (30+)
   - Invalid amounts, currencies, methods
   - Email format validation
   - Customer ID format validation
   - Boundary conditions

3. **Error Handling Tests**
   - 404 not found
   - 409 conflict (invalid state)
   - 410 expired
   - 401 unauthorized

4. **Security Tests**
   - Long inputs (email, customer ID)
   - Special characters
   - UUID format validation
   - State machine constraints

### Running Tests

```bash
# All tests
npm test

# With coverage report
npm test -- --coverage

# Specific test file
npm test -- checkout.test.ts

# Watch mode
npm test -- --watch
```

---

## Error Handling

### Error Response Format

```json
{
  "success": false,
  "code": "ERROR_CODE",
  "message": "Human-readable message",
  "details": {
    "field": "fieldName",
    "provided": "value",
    "reason": "explanation"
  }
}
```

### Error Codes

```typescript
INVALID_AMOUNT              // Amount validation failed
INVALID_CURRENCY            // Unsupported currency
INVALID_EMAIL               // Email format invalid
INVALID_PAYMENT_METHOD      // Unsupported payment method
INVALID_CUSTOMER_ID         // Customer ID format invalid
MISSING_REQUIRED_FIELD      // Required field missing
SESSION_NOT_FOUND           // Session ID doesn't exist
SESSION_EXPIRED             // Session past expiration
INVALID_SESSION_STATE       // Cannot transition from current state
UNAUTHORIZED                // Authorization required
INTERNAL_ERROR              // Server error
```

---

## Examples

### Create a Checkout Session

```bash
curl -X POST http://localhost:3001/api/v1/checkout/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "payment": {
      "amount": 10000,
      "currency": "USD",
      "paymentMethod": "credit_card"
    },
    "customer": {
      "customerId": "cust_123",
      "email": "john@example.com"
    }
  }'
```

### Get Session Status

```bash
curl http://localhost:3001/api/v1/checkout/sessions/550e8400-e29b-41d4-a716-446655440000
```

### Complete Payment

```bash
curl -X POST http://localhost:3001/api/v1/checkout/sessions/550e8400-e29b-41d4-a716-446655440000/complete \
  -H "Content-Type: application/json" \
  -d '{"paymentToken": "tok_visa_1234"}'
```

### Cancel Session

```bash
curl -X POST http://localhost:3001/api/v1/checkout/sessions/550e8400-e29b-41d4-a716-446655440000/cancel
```

---

## Design Decisions

1. **UUID for Session IDs**
   - Prevents enumeration attacks
   - Globally unique without coordination
   - 36-character format with validation

2. **Unix Timestamps** (seconds)
   - Consistent with industry standards
   - Compatible with Stellar blockchain
   - Easy calculation of expiration

3. **In-Memory Storage**
   - Fast for development/MVP
   - Service layer abstraction enables database migration
   - Cleanup mechanism prevents unbounded growth

4. **Whitelist Validation**
   - Safer than blacklist approach
   - Clear definition of supported values
   - Easy to audit and extend

5. **Stateful Sessions with TTL**
   - 24-hour window typical for checkout flows
   - Prevents stale session reuse
   - Automatic cleanup reduces memory

---

## Future Enhancements

- [ ] Database persistence (PostgreSQL, MongoDB)
- [ ] Webhook notifications on state changes
- [ ] Idempotency keys for create operations
- [ ] Payment provider integrations (Stripe, etc.)
- [ ] Advanced authorization (OAuth2, API keys)
- [ ] Session list with pagination
- [ ] Analytics and metrics
- [ ] Rate limiting middleware
- [ ] Audit logging

---

## Contributing

- Follow the validation patterns for new fields
- Add tests for any new business logic (target 95%+ coverage)
- Update this documentation for API changes
- Use error codes from `CheckoutErrorCode` enum

---

## License

MIT
