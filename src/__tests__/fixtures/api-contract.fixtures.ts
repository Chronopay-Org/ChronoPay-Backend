/**
 * API Contract Test Fixtures
 * 
 * Provides deterministic test data for API contract tests.
 * All fixtures are immutable and contain NO secrets, PII, or production data.
 * Fixtures follow the actual API schema for slots, checkout, and buyer-profile.
 */

export namespace SlotFixtures {
  export const VALID_SLOT_REQUEST = {
    professional: "prof_001",
    startTime: 1630000000,
    endTime: 1630003600,
  };

  export const VALID_SLOT_WITH_METADATA = {
    professional: "prof_002",
    startTime: 1630010000,
    endTime: 1630013600,
    metadata: {
      location: "New York",
      timezone: "America/New_York",
    },
  };

  export const INVALID_SLOT_END_TIME_LTE_START = {
    professional: "prof_001",
    startTime: 1630003600,
    endTime: 1630003600, // endTime equal to startTime
  };

  export const INVALID_SLOT_END_TIME_BEFORE_START = {
    professional: "prof_001",
    startTime: 1630003600,
    endTime: 1630000000, // endTime before startTime
  };

  export const INVALID_SLOT_MISSING_PROFESSIONAL = {
    startTime: 1630000000,
    endTime: 1630003600,
  };

  export const INVALID_SLOT_MISSING_START_TIME = {
    professional: "prof_001",
    endTime: 1630003600,
  };

  export const INVALID_SLOT_MISSING_END_TIME = {
    professional: "prof_001",
    startTime: 1630000000,
  };

  export const INVALID_SLOT_NON_NUMERIC_TIMES = {
    professional: "prof_001",
    startTime: "not-a-number",
    endTime: "also-not-a-number",
  };

  export const PAGINATION_PARAMS = {
    VALID_PAGE_1_LIMIT_10: { page: 1, limit: 10 },
    VALID_PAGE_2_LIMIT_5: { page: 2, limit: 5 },
    VALID_PAGE_1_LIMIT_100: { page: 1, limit: 100 }, // max allowed
    INVALID_PAGE_0: { page: 0, limit: 10 },
    INVALID_PAGE_NEGATIVE: { page: -1, limit: 10 },
    INVALID_LIMIT_0: { page: 1, limit: 0 },
    INVALID_LIMIT_NEGATIVE: { page: 1, limit: -1 },
    INVALID_LIMIT_OVER_MAX: { page: 1, limit: 101 },
  };

  export const EXPECTED_SLOT_RESPONSE_ENVELOPE = {
    slots: expect.any(Array),
    page: expect.any(Number),
    limit: expect.any(Number),
    total: expect.any(Number),
  };

  export const EXPECTED_SLOT_OBJECT = {
    id: expect.any(Number),
    professional: expect.any(String),
    startTime: expect.any(Number),
    endTime: expect.any(Number),
  };
}

export namespace CheckoutFixtures {
  export const VALID_SESSION_REQUEST = {
    payment: {
      amount: 10000, // $100.00
      currency: "USD" as const,
      paymentMethod: "credit_card" as const,
    },
    customer: {
      customerId: "cust_test_001",
      email: "test@example.com",
    },
  };

  export const VALID_SESSION_WITH_METADATA = {
    payment: {
      amount: 5000,
      currency: "EUR" as const,
      paymentMethod: "bank_transfer" as const,
      description: "Test payment",
    },
    customer: {
      customerId: "cust_test_002",
      email: "customer@test.com",
      firstName: "John",
      lastName: "Doe",
      address: {
        street: "123 Main St",
        city: "New York",
        state: "NY",
        postalCode: "10001",
        country: "US",
      },
    },
    metadata: {
      orderId: "ORD-12345",
      userId: "user_123",
    },
    successUrl: "https://example.com/success",
    cancelUrl: "https://example.com/cancel",
  };

  export const VALID_XLM_SESSION = {
    payment: {
      amount: 1000000, // 1 XLM in stroops
      currency: "XLM" as const,
      paymentMethod: "crypto" as const,
    },
    customer: {
      customerId: "stellar_wallet_123",
      email: "wallet@stellar.com",
    },
  };

  export const INVALID_SESSION_MISSING_PAYMENT = {
    customer: {
      customerId: "cust_test_003",
      email: "test@example.com",
    },
  };

  export const INVALID_SESSION_MISSING_CUSTOMER = {
    payment: {
      amount: 1000,
      currency: "USD" as const,
      paymentMethod: "credit_card" as const,
    },
  };

  export const INVALID_SESSION_NEGATIVE_AMOUNT = {
    payment: {
      amount: -1000,
      currency: "USD" as const,
      paymentMethod: "credit_card" as const,
    },
    customer: {
      customerId: "cust_test_004",
      email: "test@example.com",
    },
  };

  export const INVALID_SESSION_ZERO_AMOUNT = {
    payment: {
      amount: 0,
      currency: "USD" as const,
      paymentMethod: "credit_card" as const,
    },
    customer: {
      customerId: "cust_test_005",
      email: "test@example.com",
    },
  };

  export const INVALID_SESSION_INVALID_CURRENCY = {
    payment: {
      amount: 1000,
      currency: "INVALID" as any,
      paymentMethod: "credit_card" as const,
    },
    customer: {
      customerId: "cust_test_006",
      email: "test@example.com",
    },
  };

  export const INVALID_SESSION_INVALID_EMAIL = {
    payment: {
      amount: 1000,
      currency: "USD" as const,
      paymentMethod: "credit_card" as const,
    },
    customer: {
      customerId: "cust_test_007",
      email: "not-an-email",
    },
  };

  export const INVALID_SESSION_MISSING_CUSTOMER_ID = {
    payment: {
      amount: 1000,
      currency: "USD" as const,
      paymentMethod: "credit_card" as const,
    },
    customer: {
      email: "test@example.com",
    } as any,
  };

  export const INVALID_SESSION_MISSING_EMAIL = {
    payment: {
      amount: 1000,
      currency: "USD" as const,
      paymentMethod: "credit_card" as const,
    },
    customer: {
      customerId: "cust_test_008",
    } as any,
  };

  export const EXPECTED_CHECKOUT_RESPONSE_ENVELOPE = {
    success: true,
    session: expect.any(Object),
    checkoutUrl: expect.any(String),
  };

  export const EXPECTED_CHECKOUT_SESSION_OBJECT = {
    id: expect.any(String),
    payment: expect.any(Object),
    customer: expect.any(Object),
    status: expect.any(String),
    createdAt: expect.any(Number),
    expiresAt: expect.any(Number),
  };

  export const EXPECTED_ERROR_RESPONSE_ENVELOPE = {
    success: false,
    error: expect.any(String),
  };

  export const VALID_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
}

export namespace BuyerProfileFixtures {
  export const VALID_CREATE_REQUEST = {
    userId: "user_test_001",
    fullName: "John Test User",
    email: "test@example.com",
    phoneNumber: "+1234567890",
  };

  export const VALID_CREATE_WITH_ADDRESS = {
    userId: "user_test_002",
    fullName: "Jane Test User",
    email: "jane@example.com",
    phoneNumber: "+0987654321",
    address: "123 Test Street, New York, NY 10001",
    avatarUrl: "https://example.com/avatar.jpg",
  };

  export const INVALID_CREATE_MISSING_USER_ID = {
    fullName: "John Test",
    email: "test@example.com",
    phoneNumber: "+1234567890",
  } as any;

  export const INVALID_CREATE_MISSING_FULL_NAME = {
    userId: "user_test_003",
    email: "test@example.com",
    phoneNumber: "+1234567890",
  } as any;

  export const INVALID_CREATE_MISSING_EMAIL = {
    userId: "user_test_004",
    fullName: "John Test",
    phoneNumber: "+1234567890",
  } as any;

  export const INVALID_CREATE_MISSING_PHONE = {
    userId: "user_test_005",
    fullName: "John Test",
    email: "test@example.com",
  } as any;

  export const INVALID_CREATE_INVALID_EMAIL = {
    userId: "user_test_006",
    fullName: "John Test",
    email: "not-an-email",
    phoneNumber: "+1234567890",
  };

  export const INVALID_CREATE_INVALID_PHONE = {
    userId: "user_test_007",
    fullName: "John Test",
    email: "test@example.com",
    phoneNumber: "invalid-phone",
  };

  export const VALID_UPDATE_REQUEST = {
    fullName: "John Updated",
    phoneNumber: "+9999999999",
  };

  export const VALID_UPDATE_FULL = {
    fullName: "Jane Updated",
    email: "janeupdated@example.com",
    phoneNumber: "+8888888888",
    address: "456 Updated Street",
    avatarUrl: "https://example.com/new-avatar.jpg",
  };

  export const INVALID_UPDATE_INVALID_EMAIL = {
    email: "invalid-email",
  };

  export const EXPECTED_PROFILE_RESPONSE_ENVELOPE = {
    success: true,
    data: expect.any(Object),
  };

  export const EXPECTED_PROFILE_OBJECT = {
    id: expect.any(String),
    userId: expect.any(String),
    fullName: expect.any(String),
    email: expect.any(String),
    phoneNumber: expect.any(String),
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
  };

  export const EXPECTED_LIST_RESPONSE_ENVELOPE = {
    success: true,
    data: expect.any(Array),
    pagination: expect.any(Object),
  };

  export const EXPECTED_ERROR_RESPONSE_ENVELOPE = {
    success: false,
    error: expect.any(String),
  };

  export const VALID_PROFILE_ID = "550e8400-e29b-41d4-a716-446655440001";
  export const VALID_USER_ID = "user_test_valid";
}

export namespace CommonFixtures {
  export const API_KEY_HEADER = "x-api-key";
  export const VALID_API_KEY = "test-api-key";
  export const INVALID_API_KEY = "invalid-key";

  export const RATE_LIMIT_HEADERS = {
    rateLimit: "RateLimit-Limit",
    rateLimitRemaining: "RateLimit-Remaining",
    rateLimitReset: "RateLimit-Reset",
  };

  export const CACHE_HEADERS = {
    cache: "X-Cache",
    cacheHIT: "HIT",
    cacheMISS: "MISS",
  };

  export const ERROR_CODES = {
    MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",
    INVALID_INPUT: "INVALID_INPUT",
    INVALID_PAGINATION: "INVALID_PAGINATION",
    FEATURE_DISABLED: "FEATURE_DISABLED",
    UNAUTHORIZED: "UNAUTHORIZED",
    NOT_FOUND: "NOT_FOUND",
  };

  export const HTTP_STATUS_CODES = {
    OK: 200,
    CREATED: 201,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    UNPROCESSABLE_ENTITY: 422,
    TOO_MANY_REQUESTS: 429,
    SERVICE_UNAVAILABLE: 503,
    INTERNAL_SERVER_ERROR: 500,
  };

  export const MALFORMED_JSON_BODY = "{ invalid json";

  export const STANDARD_ERROR_ENVELOPE = {
    success: false,
    error: expect.any(String),
  };

  export const STANDARD_SUCCESS_ENVELOPE = {
    success: true,
  };
}
