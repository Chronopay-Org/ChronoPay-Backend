# API Contract Testing Workflow

## Overview

This document describes the API contract test suite for ChronoPay Backend. Contract tests validate the public API's behavior (status codes, response envelopes, headers, pagination, error handling) without making real external calls. They provide a deterministic, fast baseline for regression detection as features evolve.

## What Are Contract Tests?

Contract tests verify the **service-to-consumer contract** — the API's public interface and its adherence to a documented specification. They differ from unit tests (which test individual functions) and integration tests (which test systems together); contract tests focus exclusively on:

- **HTTP Status Codes**: Ensuring correct 200, 201, 400, 401, 403, 404, 422, 429, 500, 503 responses
- **Response Envelopes**: Validating consistent JSON structure across success and error paths
- **Headers**: Checking cache headers (X-Cache), rate limit headers (RateLimit-*), content-type
- **Error Codes & Messages**: Ensuring errors are informative without leaking secrets or stack traces
- **Pagination & Filtering**: Validating page/limit parameters, data structure
- **Authorization & Security**: Confirming API keys, owner checks, and soft-delete behavior

## File Structure

```
src/
├── __tests__/
│   ├── fixtures/
│   │   └── api-contract.fixtures.ts          # Immutable test data
│   ├── contracts/
│   │   ├── slots.contract.test.ts            # GET/POST /api/v1/slots
│   │   ├── checkout.contract.test.ts         # POST/GET /api/v1/checkout/sessions
│   │   └── buyer-profile.contract.test.ts    # CRUD /api/v1/buyer-profiles
│   ├── helpers/
│   │   └── integrationHarness.ts             # Test app factory
│   └── ...other test files...
├── routes/
│   ├── slots.ts
│   ├── checkout.ts
│   └── ...
└── docs/
    └── testing/
        └── contracts.md                       # This file
```

## Running Contract Tests

### Run All Tests

```bash
npm test
```

This runs all Jest tests, including contract tests. Jest automatically discovers files matching `**/__tests__/**/*.test.ts`.

### Run Contract Tests Only

```bash
npm test -- --testPathPattern=contracts
```

### Run Specific Endpoint Contract Tests

```bash
# Slots only
npm test -- --testPathPattern=slots.contract

# Checkout only
npm test -- --testPathPattern=checkout.contract

# Buyer profiles only
npm test -- --testPathPattern=buyer-profile.contract
```

### Watch Mode (Development)

```bash
npm test -- --watch
```

Automatically re-runs tests when files change.

### Coverage Report

```bash
npm test -- --coverage
```

Generates coverage report in `coverage/`. Target: **95% line coverage** on tested code paths.

## Test Data & Fixtures

All test data is defined in `src/__tests__/fixtures/api-contract.fixtures.ts`. Fixtures are **immutable and contain NO secrets, PII, or production data**. They follow actual API schemas:

### Slot Fixtures

- `VALID_SLOT_REQUEST`: Standard slot creation payload
- `VALID_SLOT_WITH_METADATA`: Slot with optional metadata
- `INVALID_SLOT_*`: Validation failure scenarios
- `PAGINATION_PARAMS`: Valid and invalid page/limit combinations
- `EXPECTED_SLOT_RESPONSE_ENVELOPE`: Expected response shape

### Checkout Fixtures

- `VALID_SESSION_REQUEST`: Minimal session creation payload
- `VALID_SESSION_WITH_METADATA`: Full session with customer info, metadata, redirects
- `VALID_XLM_SESSION`: Crypto payment (XLM) example
- `INVALID_SESSION_*`: Amount, currency, email validation failures
- `EXPECTED_CHECKOUT_RESPONSE_ENVELOPE`: Success and error response shapes

### Buyer Profile Fixtures

- `VALID_CREATE_REQUEST`: Minimal profile creation
- `VALID_CREATE_WITH_ADDRESS`: Full profile with address and avatar
- `INVALID_CREATE_*`: Missing fields, invalid formats
- `VALID_UPDATE_REQUEST`: Partial update payload
- `EXPECTED_PROFILE_*`: Response envelope shapes

### Common Fixtures

- `API_KEY_HEADER`, `VALID_API_KEY`, `INVALID_API_KEY`: Auth fixtures
- `RATE_LIMIT_HEADERS`: Expected header names
- `CACHE_HEADERS`: Cache hit/miss header names
- `HTTP_STATUS_CODES`: Standard HTTP codes (200, 201, 400, 422, 503, etc.)
- `ERROR_CODES`: Standardized error codes (MISSING_REQUIRED_FIELD, INVALID_INPUT, etc.)
- `MALFORMED_JSON_BODY`: For parsing error tests

## Test Categories

Each contract test file covers:

### 1. **Happy Path Tests**

Validate successful operations:

```typescript
it("should create session with valid payload and return 201", async () => {
  const res = await harness.request
    .post("/api/v1/checkout/sessions")
    .send(CheckoutFixtures.VALID_SESSION_REQUEST);

  expect(res.status).toBe(201);
  expect(res.body.success).toBe(true);
  expect(res.body.session).toMatchObject(EXPECTED_SESSION_SHAPE);
});
```

### 2. **Input Validation Tests**

Ensure invalid inputs are rejected with proper status codes and error messages:

```typescript
it("should reject missing required field with 400", async () => {
  const res = await harness.request
    .post("/api/v1/checkout/sessions")
    .send({ payment: { amount: 1000 } }); // missing customer

  expect(res.status).toBe(400);
  expect(res.body.error).toBeDefined();
});
```

### 3. **Semantic Validation Tests**

Validate business rules (e.g., amount must be positive, endTime > startTime):

```typescript
it("should reject zero amount with 422", async () => {
  const res = await harness.request
    .post("/api/v1/checkout/sessions")
    .send({ ...validPayload, payment: { ...validPayment, amount: 0 } });

  expect(res.status).toBe(422);
});
```

### 4. **Authorization & Authentication Tests**

Verify API key validation and ownership checks:

```typescript
it("should reject request without API key with 401", async () => {
  const res = await harness.request
    .post("/api/v1/slots")
    .send(validSlot); // no x-api-key header

  expect(res.status).toBe(401);
});
```

### 5. **Error Handling & Edge Cases**

Validate graceful handling of malformed requests, missing resources, server faults:

```typescript
it("should return 404 for non-existent resource", async () => {
  const res = await harness.request
    .get("/api/v1/buyer-profiles/non-existent-id");

  expect(res.status).toBe(404);
  expect(res.body.error).toBeDefined();
});

it("should return sanitized error for unhandled exception", async () => {
  const res = await harness.request.get("/__test__/explode");

  expect(res.status).toBe(500);
  expect(res.body.error).not.toMatch(/at /); // No stack trace
});
```

### 6. **Security Tests**

Confirm sensitive data is not leaked in responses or errors:

```typescript
it("should not expose internal fields in response", async () => {
  const res = await harness.request
    .post("/api/v1/checkout/sessions")
    .send(validPayload);

  expect(res.body.session).not.toHaveProperty("_internalId");
  expect(res.body.session).not.toHaveProperty("_secret");
});

it("should not leak email in error messages", async () => {
  const res = await harness.request
    .post("/api/v1/buyer-profiles")
    .send({ ...invalidPayload, email: "invalid@example.com" });

  expect(res.body.error).not.toContain("@");
});
```

## Coverage & Quality Metrics

### Target Coverage

- **95% line coverage** on touched API route handler and validation code
- **100% of HTTP status code paths** (200, 201, 400, 401, 403, 404, 422, 500, 503)
- **100% of error scenarios** (missing field, invalid format, duplicate, etc.)

### Checking Coverage

```bash
npm test -- --coverage --collectCoverageFrom="src/routes/**/*.ts"
```

Coverage summary will show line, branch, function, and statement percentages. Uncovered lines will be highlighted in `coverage/lcov-report/index.html`.

## Security Validation

Contract tests enforce security assumptions:

1. **No PII in Fixtures**: Test data uses generic values (`test@example.com`, `+1234567890`)
2. **No Secrets in Responses**: Tests verify internal fields (`_secret`, `_internalId`, `apiKeyUsed`) are never exposed
3. **Sanitized Errors**: Error messages do not leak user input (email, phone) or stack traces
4. **API Key Gating**: POST endpoints require valid `x-api-key` header
5. **Soft Delete**: Deleted profiles are not retrievable (return 404)
6. **Email Normalization**: Emails stored and returned lowercase to prevent case-sensitivity exploits

## Integration with CI/CD

Contract tests run as part of the standard CI pipeline:

```yaml
# GitHub Actions (or similar)
- name: Install dependencies
  run: npm ci

- name: Build
  run: npm run build

- name: Test (including contracts)
  run: npm test

- name: Coverage report
  run: npm test -- --coverage
```

Tests must pass before a PR can be merged.

## Maintenance & Updates

### When to Update Fixtures

Update fixtures in `api-contract.fixtures.ts` when:

- **API schema changes** (new required fields, renamed parameters)
- **New error codes** are introduced
- **Status code behavior** changes (e.g., 409 instead of 400 for duplicates)
- **Pagination limits** are adjusted

### When to Add Tests

Add new contract tests when:

- **New endpoint is added** (e.g., PUT /api/v1/buyer-profiles/:id/preferences)
- **New query parameter is introduced** (e.g., filtering, sorting)
- **New error scenario** must be handled (e.g., session expired, rate limit exceeded)
- **Security concern** is identified

### Example: Adding a New Endpoint

1. Create fixture in `api-contract.fixtures.ts`:
   ```typescript
   export namespace MyEndpointFixtures {
     export const VALID_REQUEST = { /* ... */ };
     export const INVALID_REQUEST_MISSING_FIELD = { /* ... */ };
   }
   ```

2. Create test file `src/__tests__/contracts/my-endpoint.contract.test.ts`:
   ```typescript
   describe("MyEndpoint API Contract Tests", () => {
     // Follow existing patterns...
   });
   ```

3. Run tests: `npm test -- --testPathPattern=my-endpoint.contract`

4. Update this document with new coverage summary.

## Debugging Failed Tests

### Enable Debug Logging

```bash
DEBUG=* npm test -- --testPathPattern=checkout.contract
```

### Use Jest Interactive Mode

```bash
npm test -- --testPathPattern=checkout.contract --watch
```

Press `p` to filter by filename, `t` to filter by test name, `a` to re-run all.

### Inspect Request/Response

Add console.log in test:

```typescript
it("should...", async () => {
  const res = await harness.request.post("/api/v1/...");
  console.log("Status:", res.status);
  console.log("Body:", JSON.stringify(res.body, null, 2));
  console.log("Headers:", res.headers);
  expect(res.status).toBe(200);
});
```

Run: `npm test -- --testNamePattern="should" --verbose`

## Best Practices

1. **Deterministic**: Tests do not depend on external services, database state, or time.
2. **Isolated**: Each test is independent; no test depends on another's result.
3. **Fast**: Contract tests complete in < 1 second per test.
4. **Focused**: Each test validates one contract aspect (one status code, one error, etc.).
5. **Clear Names**: Test names describe the contract being validated: `"should return 201 on valid creation"`
6. **No Flakiness**: Tests do not use `setTimeout`, random data, or retries.
7. **Maintainable**: Fixtures are centralized; tests use them consistently.

## Next Steps

1. **Run the full test suite**: `npm test`
2. **Generate coverage report**: `npm test -- --coverage`
3. **Integrate into CI**: Ensure contract tests run on every push/PR
4. **Monitor coverage**: Target 95%+ on touched lines; flag uncovered paths
5. **Review security assumptions**: Validate PII/secrets are never leaked

## References

- [Test Integration Harness](../INTEGRATION_TEST_HARNESS.md)
- [Express API Routes](../../routes/)
- [Jest Documentation](https://jestjs.io/)
- [Supertest Documentation](https://github.com/visionmedia/supertest)
- [API Security Checklist](../CHECKOUT_SECURITY.md)
