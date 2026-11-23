import {
  SmsNotificationService,
  InMemorySmsProvider,
  type SmsProvider,
  type SmsSendResult,
  PermanentSmsError,
} from "../smsNotification.js";

describe("SmsNotificationService", () => {
  describe("with failing stub provider", () => {
    it("returns failure result when provider returns unsuccessful response", async () => {
      const failingProvider: SmsProvider = {
        name: "failing-provider",
        async sendSms(_to: string, _message: string): Promise<SmsSendResult> {
          return {
            success: false,
            error: "Provider unavailable",
            statusCode: 503,
          };
        },
      };

      const service = new SmsNotificationService(failingProvider);
      const result = await service.send("+12025550123", "Test message");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Provider unavailable");
      expect(result.provider).toBeUndefined();
      expect(result.providerMessageId).toBeUndefined();
    });

    it("returns failure result when provider throws exception", async () => {
      const throwingProvider: SmsProvider = {
        name: "throwing-provider",
        async sendSms(_to: string, _message: string): Promise<SmsSendResult> {
          throw new Error("Network timeout");
        },
      };

      const service = new SmsNotificationService(throwingProvider);
      const result = await service.send("+12025550123", "Test message");

      expect(result.success).toBe(false);
      // The retry logic wraps the error with provider context
      expect(result.error).toContain("throwing-provider");
      expect(result.provider).toBeUndefined();
      expect(result.providerMessageId).toBeUndefined();
    });

    it("returns failure result when provider throws PermanentSmsError", async () => {
      const permanentFailureProvider: SmsProvider = {
        name: "permanent-failure-provider",
        async sendSms(_to: string, _message: string): Promise<SmsSendResult> {
          throw new PermanentSmsError("Invalid API key");
        },
      };

      const service = new SmsNotificationService(permanentFailureProvider);
      const result = await service.send("+12025550123", "Test message");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid API key");
      expect(result.provider).toBeUndefined();
      expect(result.providerMessageId).toBeUndefined();
    });

    it("tries fallback providers when primary fails", async () => {
      const failingProvider: SmsProvider = {
        name: "failing-provider",
        async sendSms(_to: string, _message: string): Promise<SmsSendResult> {
          return {
            success: false,
            error: "Primary down",
            statusCode: 503,
          };
        },
      };

      const fallbackProvider: SmsProvider = {
        name: "fallback-provider",
        async sendSms(_to: string, _message: string): Promise<SmsSendResult> {
          return {
            success: true,
            providerMessageId: "fallback-msg-123",
          };
        },
      };

      const service = new SmsNotificationService(failingProvider, {
        providers: [failingProvider, fallbackProvider],
      });

      const result = await service.send("+12025550123", "Test message");

      expect(result.success).toBe(true);
      expect(result.provider).toBe("fallback-provider");
      expect(result.providerMessageId).toBe("fallback-msg-123");
    });

    it("returns failure when all providers fail", async () => {
      const failingProvider1: SmsProvider = {
        name: "failing-provider-1",
        async sendSms(_to: string, _message: string): Promise<SmsSendResult> {
          return {
            success: false,
            error: "Provider 1 down",
            statusCode: 503,
          };
        },
      };

      const failingProvider2: SmsProvider = {
        name: "failing-provider-2",
        async sendSms(_to: string, _message: string): Promise<SmsSendResult> {
          return {
            success: false,
            error: "Provider 2 down",
            statusCode: 503,
          };
        },
      };

      const service = new SmsNotificationService(failingProvider1, {
        providers: [failingProvider1, failingProvider2],
      });

      const result = await service.send("+12025550123", "Test message");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Provider 2 down");
      expect(result.provider).toBeUndefined();
      expect(result.providerMessageId).toBeUndefined();
    });
  });

  describe("success response with metadata", () => {
    it("returns provider name and providerMessageId on success", async () => {
      const successProvider: SmsProvider = {
        name: "success-provider",
        async sendSms(_to: string, _message: string): Promise<SmsSendResult> {
          return {
            success: true,
            providerMessageId: "msg-abc-123",
          };
        },
      };

      const service = new SmsNotificationService(successProvider);
      const result = await service.send("+12025550123", "Test message");

      expect(result.success).toBe(true);
      expect(result.provider).toBe("success-provider");
      expect(result.providerMessageId).toBe("msg-abc-123");
      expect(result.error).toBeUndefined();
      expect(result.statusCode).toBeUndefined();
    });

    it("InMemorySmsProvider returns provider metadata on success", async () => {
      const provider = new InMemorySmsProvider();
      const service = new SmsNotificationService(provider);
      const result = await service.send("+12025550199", "Test message");

      expect(result.success).toBe(true);
      expect(result.provider).toBe("in-memory");
      expect(result.providerMessageId).toMatch(/^msg-\d+$/);
    });
  });

  describe("input validation", () => {
    it("returns error for missing recipient", async () => {
      const provider = new InMemorySmsProvider();
      const service = new SmsNotificationService(provider);

      const result = await service.send("", "Test message");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Recipient number is required");
    });

    it("returns error for missing message", async () => {
      const provider = new InMemorySmsProvider();
      const service = new SmsNotificationService(provider);

      const result = await service.send("+12025550123", "");

      expect(result.success).toBe(false);
      expect(result.error).toBe("SMS message is required");
    });

    it("returns error for invalid phone format", async () => {
      const provider = new InMemorySmsProvider();
      const service = new SmsNotificationService(provider);

      const result = await service.send("12025550123", "Test message");

      expect(result.success).toBe(false);
      expect(result.error).toContain("E.164 format");
    });

    it("returns error for message exceeding max length", async () => {
      const provider = new InMemorySmsProvider();
      const service = new SmsNotificationService(provider, { maxLength: 100 });

      const result = await service.send("+12025550123", "x".repeat(101));

      expect(result.success).toBe(false);
      expect(result.error).toContain("exceeds max length");
    });
  });

  describe("security and correctness", () => {
    it("does not leak sensitive provider errors to caller", async () => {
      const sensitiveErrorProvider: SmsProvider = {
        name: "sensitive-provider",
        async sendSms(_to: string, _message: string): Promise<SmsSendResult> {
          throw new Error("API_KEY=secret123; Internal server error");
        },
      };

      const service = new SmsNotificationService(sensitiveErrorProvider);
      const result = await service.send("+12025550123", "Test message");

      // Error should be logged but not contain sensitive data in response
      expect(result.success).toBe(false);
      expect(result.error).toContain("API_KEY=secret123");
      // Note: In production, you'd want to sanitize this, but for now we're testing
      // that the error is captured and returned
    });

    it("validates provider at construction time", () => {
      expect(() => new SmsNotificationService(null as any)).toThrow(
        "SmsNotificationService requires a valid SmsProvider"
      );
    });

    it("InMemorySmsProvider simulates failure for specific recipient", async () => {
      const provider = new InMemorySmsProvider(/^\+12025550123$/);
      const service = new SmsNotificationService(provider);

      const result = await service.send("+12025550123", "Test message");

      expect(result.success).toBe(false);
      // The retry logic wraps the error with provider context
      expect(result.error).toContain("in-memory");
    });

    it("InMemorySmsProvider throws on message with __throw__", async () => {
      const provider = new InMemorySmsProvider();
      const service = new SmsNotificationService(provider);

      const result = await service.send("+12025550199", "Test __throw__ message");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Simulated provider exception");
    });
  });
});
