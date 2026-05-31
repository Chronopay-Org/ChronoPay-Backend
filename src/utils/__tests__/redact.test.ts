/**
 * Tests for the redact utility
 *
 * Ensures secrets never reach logs by verifying:
 * - Sensitive fields are masked at any depth
 * - Non-sensitive fields pass through unchanged
 * - Nested objects and arrays are handled correctly
 * - Circular references don't cause infinite loops
 * - Case-insensitive key matching works properly
 */

// @ts-expect-error - Auto-fixed by script
import { redact, wouldBeRedacted, getSensitiveFields } from "../redact";

describe("redact utility", () => {
  describe("basic functionality", () => {
    it("should redact a simple password field", () => {
      const obj = { username: "john", password: "super-secret-password" };
      const result = redact(obj);

      expect(result).toEqual({
        username: "john",
        password: "su***rd",
      });
      expect(result.password).not.toContain("secret");
    });

    it("should redact authorization header", () => {
      const obj = { authorization: "Bearer token-secret" };
      const result = redact(obj);

      expect(result.authorization).toBe("Be***et");
    });

    it("should redact token field", () => {
      const obj = { token: "abc123def456ghi789" };
      const result = redact(obj);

      expect(result.token).toBe("ab***89");
    });

    it("should redact apiKey field", () => {
      const obj = { apiKey: "sk-1234567890abcdef" };
      const result = redact(obj);

      expect(result.apiKey).toBe("sk***ef");
    });

    it("should not mutate the original object", () => {
      const original = {
        username: "john",
        password: "secret-password",
      };
      const copy = JSON.parse(JSON.stringify(original));

      redact(original);

      expect(original).toEqual(copy);
      expect(original.password).toBe("secret-password");
    });
  });

  describe("non-sensitive fields", () => {
    it("should pass through non-sensitive fields unchanged", () => {
      const obj = {
        id: 123,
        email: "user@example.com",
        name: "John Doe",
        active: true,
      };
      const result = redact(obj);

      expect(result).toEqual(obj);
    });

    it("should preserve field order", () => {
      const obj = { a: 1, b: 2, c: 3, d: 4 };
      const result = redact(obj);

      expect(Object.keys(result)).toEqual(["a", "b", "c", "d"]);
    });

    it("should handle null and undefined values", () => {
      const obj = {
        nullField: null,
        undefinedField: undefined,
        emptyString: "",
      };
      const result = redact(obj);

      expect(result.nullField).toBeNull();
      expect(result.undefinedField).toBeUndefined();
      expect(result.emptyString).toBe("");
    });
  });

  describe("nested objects", () => {
    it("should redact sensitive fields in nested objects", () => {
      const obj = {
        user: {
          id: 1,
          name: "John",
          credentials: {
            password: "secret-password",
            token: "token-abc123",
          },
        },
      };
      const result = redact(obj);

      expect(result.user.name).toBe("John");
      expect((result.user.credentials as any).password).toBe("se***rd");
      expect((result.user.credentials as any).token).toBe("to***23");
    });

    it("should handle deeply nested structures", () => {
      const obj = {
        level1: {
          level2: {
            level3: {
              level4: {
                password: "very-deep-secret",
              },
            },
          },
        },
      };
      const result = redact(obj);

      const level4 = (((result.level1 as any).level2 as any).level3 as any).level4 as any;
      expect(level4.password).toBe("ve***et");
    });

    it("should handle objects with mixed sensitive and non-sensitive fields", () => {
      const obj = {
        id: "user-123",
        email: "user@example.com",
        apiKey: "sk-1234567890",
        settings: {
          theme: "dark",
          password: "user-password",
          notifications: true,
        },
      };
      const result = redact(obj);

      expect(result.id).toBe("user-123");
      expect(result.email).toBe("user@example.com");
      expect(result.apiKey).toBe("sk***90");
      expect((result.settings as any).theme).toBe("dark");
      expect((result.settings as any).password).toBe("us***rd");
      expect((result.settings as any).notifications).toBe(true);
    });
  });

  describe("arrays", () => {
    it("should process arrays of objects", () => {
      const obj = {
        users: [
          { id: 1, name: "Alice", password: "pass1" },
          { id: 2, name: "Bob", password: "pass2" },
        ],
      };
      const result = redact(obj);

      const users = result.users as any[];
      expect(users).toHaveLength(2);
      expect(users[0].name).toBe("Alice");
      expect(users[0].password).toBe("pa***s1");
      expect(users[1].name).toBe("Bob");
      expect(users[1].password).toBe("pa***s2");
    });

    it("should handle arrays of primitive values", () => {
      const obj = {
        numbers: [1, 2, 3],
        strings: ["a", "b", "c"],
      };
      const result = redact(obj);

      expect(result.numbers).toEqual([1, 2, 3]);
      expect(result.strings).toEqual(["a", "b", "c"]);
    });

    it("should handle arrays with mixed types", () => {
      const obj = {
        mixed: [
          { token: "secret-token" },
          "string-value",
          123,
          { id: 1 },
        ],
      };
      const result = redact(obj);

      const mixed = result.mixed as any[];
      expect(mixed[0].token).toBe("se***en");
      expect(mixed[1]).toBe("string-value");
      expect(mixed[2]).toBe(123);
      expect(mixed[3].id).toBe(1);
    });

    it("should handle nested arrays", () => {
      const obj = {
        data: [
          [
            { password: "secret1" },
            { token: "token1" },
          ],
          [
            { password: "secret2" },
          ],
        ],
      };
      const result = redact(obj);

      const data = result.data as any[];
      expect(data[0][0].password).toBe("se***t1");
      expect(data[0][1].token).toBe("to***n1");
      expect(data[1][0].password).toBe("se***t2");
    });

    it("should handle empty arrays", () => {
      const obj = { items: [] };
      const result = redact(obj);

      expect(result.items).toEqual([]);
    });
  });

  describe("case-insensitive matching", () => {
    it("should redact Authorization with capital A", () => {
      const obj = { Authorization: "Bearer token-secret" };
      const result = redact(obj);

      expect(result.Authorization).toBe("Be***et");
    });

    it("should redact AUTHORIZATION in all caps", () => {
      const obj = { AUTHORIZATION: "Bearer token-secret" };
      const result = redact(obj);

      expect(result.AUTHORIZATION).toBe("Be***et");
    });

    it("should redact X-API-KEY with dashes", () => {
      const obj = { "X-API-KEY": "sk-prod-12345678" };
      const result = redact(obj);

      expect(result["X-API-KEY"]).toBe("sk***78");
    });

    it("should redact various case combinations of password", () => {
      const obj = {
        password: "secret1",
        PASSWORD: "secret2",
        Password: "secret3",
        PassWord: "secret4",
      };
      const result = redact(obj);

      expect(result.password).toBe("se***t1");
      expect(result.PASSWORD).toBe("se***t2");
      expect(result.Password).toBe("se***t3");
      expect(result.PassWord).toBe("se***t4");
    });

    it("should handle snake_case and camelCase variations", () => {
      const obj = {
        api_key: "secret-key-1",
        apiKey: "secret-key-2",
        API_KEY: "secret-key-3",
        ApiKey: "secret-key-4",
      };
      const result = redact(obj);

      expect(result.api_key).toBe("se***-1");
      expect(result.apiKey).toBe("se***-2");
      expect(result.API_KEY).toBe("se***-3");
      expect(result.ApiKey).toBe("se***-4");
    });
  });

  describe("various sensitive field types", () => {
    it("should redact token-related fields", () => {
      const obj = {
        token: "token-secret",
        accessToken: "access-secret",
        access_token: "access-secret",
        refreshToken: "refresh-secret",
        refresh_token: "refresh-secret",
      };
      const result = redact(obj);

      expect(result.token).toBe("to***et");
      expect(result.accessToken).toBe("ac***et");
      expect(result.access_token).toBe("ac***et");
      expect(result.refreshToken).toBe("re***et");
      expect(result.refresh_token).toBe("re***et");
    });

    it("should redact various password-like fields", () => {
      const obj = {
        password: "pass-secret",
        secret: "the-secret",
        dbPassword: "db-pass",
        db_password: "db-pass",
      };
      const result = redact(obj);

      expect(result.password).toBe("pa***et");
      expect(result.secret).toBe("th***et");
      expect(result.dbPassword).toBe("db***ss");
      expect(result.db_password).toBe("db***ss");
    });

    it("should redact API key variations", () => {
      const obj = {
        apiKey: "sk-prod-key",
        api_key: "sk-prod-key",
        appSecret: "app-secret",
        app_secret: "app-secret",
        clientSecret: "client-secret",
        client_secret: "client-secret",
      };
      const result = redact(obj);

      expect(result.apiKey).toBe("sk***ey");
      expect(result.api_key).toBe("sk***ey");
      expect(result.appSecret).toBe("ap***et");
      expect(result.app_secret).toBe("ap***et");
      expect(result.clientSecret).toBe("cl***et");
      expect(result.client_secret).toBe("cl***et");
    });

    it("should redact credential and auth-related fields", () => {
      const obj = {
        authorization: "Bearer token",
        authCode: "code-secret",
        auth_code: "code-secret",
        oauthToken: "oauth-secret",
        oauth_token: "oauth-secret",
      };
      const result = redact(obj);

      expect(result.authorization).toBe("Be***en");
      expect(result.authCode).toBe("co***et");
      expect(result.auth_code).toBe("co***et");
      expect(result.oauthToken).toBe("oa***et");
      expect(result.oauth_token).toBe("oa***et");
    });

    it("should redact encryption-related fields", () => {
      const obj = {
        encryptionKey: "encryption-secret",
        encryption_key: "encryption-secret",
        signingKey: "signing-secret",
        signing_key: "signing-secret",
        privateKey: "private-secret",
        private_key: "private-secret",
      };
      const result = redact(obj);

      expect(result.encryptionKey).toBe("en***et");
      expect(result.encryption_key).toBe("en***et");
      expect(result.signingKey).toBe("si***et");
      expect(result.signing_key).toBe("si***et");
      expect(result.privateKey).toBe("pr***et");
      expect(result.private_key).toBe("pr***et");
    });

    it("should redact webhook and other integration secrets", () => {
      const obj = {
        webhookSecret: "webhook-secret",
        webhook_secret: "webhook-secret",
        cookie: "cookie-secret",
        session: "session-secret",
        awsSecret: "aws-secret",
        aws_secret: "aws-secret",
        databaseUrl: "postgres://user:pass@host",
        database_url: "postgres://user:pass@host",
      };
      const result = redact(obj);

      expect(result.webhookSecret).toBe("we***et");
      expect(result.webhook_secret).toBe("we***et");
      expect(result.cookie).toBe("co***et");
      expect(result.session).toBe("se***et");
      expect(result.awsSecret).toBe("aw***et");
      expect(result.aws_secret).toBe("aw***et");
      expect(result.databaseUrl).toBe("po***st");
      expect(result.database_url).toBe("po***st");
    });
  });

  describe("circular references", () => {
    it("should handle circular references without infinite loops", () => {
      const obj: any = {
        id: 1,
        name: "John",
        password: "secret",
      };
      obj.self = obj;

      const result = redact(obj) as any;

      expect(result.id).toBe(1);
      expect(result.name).toBe("John");
      expect(result.password).toBe("se***et");
      expect(result.self).toBe("[Circular]");
    });

    it("should handle multiple levels of circular references", () => {
      const obj1: any = { id: 1, data: "test" };
      const obj2: any = { id: 2, data: "test2" };

      obj1.ref = obj2;
      obj2.ref = obj1;

      const result = redact(obj1) as any;

      expect(result.id).toBe(1);
      expect(result.ref.id).toBe(2);
      expect(result.ref.ref).toBe("[Circular]");
    });

    it("should handle password in circular reference", () => {
      const obj: any = {
        user: {
          id: 1,
          password: "secret",
        },
      };
      obj.user.parent = obj;

      const result = redact(obj) as any;

      expect(result.user.password).toBe("se***et");
      expect(result.user.parent).toBe("[Circular]");
    });
  });

  describe("edge cases", () => {
    it("should handle empty objects", () => {
      const result = redact({});
      expect(result).toEqual({});
    });

    it("should handle null values", () => {
      const result = redact(null);
      expect(result).toBeNull();
    });

    it("should handle undefined values", () => {
      const result = redact(undefined);
      expect(result).toBeUndefined();
    });

    it("should handle primitive values directly", () => {
      expect(redact("string")).toBe("string");
      expect(redact(123)).toBe(123);
      expect(redact(true)).toBe(true);
    });

    it("should handle Date objects", () => {
      const date = new Date("2024-01-01");
      const obj = { createdAt: date, password: "secret" };
      const result = redact(obj) as any;

      expect(result.createdAt).toEqual(date);
      expect(result.password).toBe("se***et");
    });

    it("should handle very long sensitive values", () => {
      const longValue = "a".repeat(1000);
      const obj = { password: longValue };
      const result = redact(obj) as any;

      expect(result.password).toBe("aa***aa");
      expect(result.password.length).toBe(7);
    });

    it("should handle short sensitive values (< 5 chars)", () => {
      const obj = {
        password: "a",
        secret: "ab",
        token: "abc",
        apiKey: "abcd",
        authorization: "abcde",
      };
      const result = redact(obj);

      expect(result.password).toBe("***");
      expect(result.secret).toBe("***");
      expect(result.token).toBe("***");
      expect(result.apiKey).toBe("***");
      expect(result.authorization).toBe("ab***de");
    });

    it("should handle numeric password fields", () => {
      const obj = { password: 123456 };
      const result = redact(obj) as any;

      expect(result.password).toBe("***");
    });

    it("should handle boolean password fields", () => {
      const obj = { password: true };
      const result = redact(obj) as any;

      expect(result.password).toBe("***");
    });

    it("should handle fields with special characters", () => {
      const obj = {
        "x-api-key": "sk-test-12345",
        "content-type": "application/json",
      };
      const result = redact(obj);

      expect(result["x-api-key"]).toBe("sk***45");
      expect(result["content-type"]).toBe("application/json");
    });
  });

  describe("complex real-world scenarios", () => {
    it("should redact an authentication response", () => {
      const authResponse = {
        success: true,
        user: {
          id: "user-123",
          email: "user@example.com",
          name: "John Doe",
        },
        token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9result",
        refreshToken: "refresh-token-secret-value",
        expiresIn: 3600,
      };
      const result = redact(authResponse) as any;

      expect(result.success).toBe(true);
      expect(result.user.email).toBe("user@example.com");
      expect(result.token).not.toContain("eyJ");
      expect(result.token).toBe("ey***lt");
      expect(result.refreshToken).toBe("re***ue");
      expect(result.expiresIn).toBe(3600);
    });

    it("should redact an API request with headers and body", () => {
      const request = {
        method: "POST",
        url: "/api/payment",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer eyJhbGciOiJIUzI1NiJ...",
          "x-api-key": "sk-prod-123456789",
        },
        body: {
          amount: 99.99,
          currency: "USD",
          cardToken: "tok_visa_4242",
          password: "user-password",
        },
      };
      const result = redact(request) as any;

      expect(result.method).toBe("POST");
      expect(result.url).toBe("/api/payment");
      expect(result.headers["content-type"]).toBe("application/json");
      expect(result.headers.authorization).toBe("Be***..");
      expect(result.headers["x-api-key"]).toBe("sk***89");
      expect(result.body.amount).toBe(99.99);
      expect(result.body.cardToken).toBe("to***42");
      expect(result.body.password).toBe("us***rd");
    });

    it("should redact database connection config", () => {
      const config = {
        database: {
          host: "db.example.com",
          port: 5432,
          username: "admin",
          password: "super-secret-password",
          database: "chronopay",
          ssl: true,
          poolMin: 10,
          poolMax: 100,
        },
        redis: {
          host: "redis.example.com",
          port: 6379,
          password: "redis-secret-password",
        },
      };
      const result = redact(config) as any;

      expect(result.database.host).toBe("db.example.com");
      expect(result.database.username).toBe("admin");
      expect(result.database.password).toBe("su***rd");
      expect(result.database.poolMax).toBe(100);
      expect(result.redis.password).toBe("re***rd");
    });

    it("should redact error logs with credentials", () => {
      const errorLog = {
        timestamp: "2024-01-15T10:30:00Z",
        level: "ERROR",
        message: "Authentication failed",
        error: {
          name: "AuthenticationError",
          message: "Invalid credentials",
        },
        context: {
          userId: "user-123",
          attempt: 3,
        },
        attemptedPassword: {
          email: "user@example.com",
          password: "wrong-password",
        },
      };
      const result = redact(errorLog) as any;

      expect(result.timestamp).toBe("2024-01-15T10:30:00Z");
      expect(result.level).toBe("ERROR");
      expect(result.error.name).toBe("AuthenticationError");
      expect(result.context.userId).toBe("user-123");
      expect(result.attemptedPassword.email).toBe("user@example.com");
      expect(result.attemptedPassword.password).toBe("wr***rd");
    });

    it("should redact webhook payload", () => {
      const webhook = {
        id: "evt_123456",
        timestamp: 1234567890,
        event: "payment.completed",
        data: {
          paymentId: "pay_abc123",
          amount: 99.99,
          currency: "USD",
          customer: {
            id: "cust_xyz789",
            email: "customer@example.com",
            apiKey: "sk-customer-secret-key",
          },
          metadata: {
            order_id: "ord_123",
            tracking_token: "track-secret-12345",
          },
        },
      };
      const result = redact(webhook) as any;

      expect(result.id).toBe("evt_123456");
      expect(result.data.paymentId).toBe("pay_abc123");
      expect(result.data.customer.email).toBe("customer@example.com");
      expect(result.data.customer.apiKey).toBe("sk***ey");
      expect(result.data.metadata.order_id).toBe("ord_123");
      expect(result.data.metadata.tracking_token).toBe("tr***45");
    });
  });

  describe("utility functions", () => {
    describe("wouldBeRedacted", () => {
      it("should identify fields that would be redacted", () => {
        expect(wouldBeRedacted("password")).toBe(true);
        expect(wouldBeRedacted("token")).toBe(true);
        expect(wouldBeRedacted("authorization")).toBe(true);
        expect(wouldBeRedacted("apiKey")).toBe(true);
      });

      it("should identify non-sensitive fields", () => {
        expect(wouldBeRedacted("email")).toBe(false);
        expect(wouldBeRedacted("name")).toBe(false);
        expect(wouldBeRedacted("userId")).toBe(false);
      });

      it("should be case-insensitive", () => {
        expect(wouldBeRedacted("PASSWORD")).toBe(true);
        expect(wouldBeRedacted("Password")).toBe(true);
        expect(wouldBeRedacted("AUTHORIZATION")).toBe(true);
      });
    });

    describe("getSensitiveFields", () => {
      it("should return list of sensitive field names", () => {
        const fields = getSensitiveFields();
        expect(Array.isArray(fields)).toBe(true);
        expect(fields.length).toBeGreaterThan(0);
      });

      it("should include common sensitive fields", () => {
        const fields = getSensitiveFields();
        expect(fields).toContain("password");
        expect(fields).toContain("token");
        expect(fields).toContain("authorization");
        expect(fields).toContain("apikey");
      });

      it("should return lowercase field names", () => {
        const fields = getSensitiveFields();
        // @ts-expect-error - Auto-fixed by script
        fields.forEach((field) => {
          expect(field).toBe(field.toLowerCase());
        });
      });
    });
  });

  describe("deterministic behavior", () => {
    it("should produce consistent results for multiple calls", () => {
      const obj = {
        id: 1,
        password: "secret",
        nested: {
          token: "token-value",
        },
      };

      const result1 = redact(obj);
      const result2 = redact(obj);

      expect(result1).toEqual(result2);
      expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
    });

    it("should mask values consistently", () => {
      const obj = { password: "secret123456" };
      const result = redact(obj) as any;

      expect(result.password).toBe("se***56");
      expect(result.password).toBe((redact(obj) as any).password);
    });
  });
});
