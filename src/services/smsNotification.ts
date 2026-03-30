export interface SmsSendResult {
  success: boolean;
  provider?: string;
  providerMessageId?: string;
  error?: string;
}

export interface SmsProvider {
  name: string;
  sendSms(to: string, message: string): Promise<SmsSendResult>;
}

export interface SmsOptions {
  maxLength?: number;
  allowedToPattern?: RegExp;
}

export class SmsNotificationService {
  private readonly provider: SmsProvider;
  private readonly maxLength: number;
  private readonly allowedToPattern: RegExp;

  constructor(provider: SmsProvider, options?: SmsOptions) {
    this.provider = provider;
    this.maxLength = options?.maxLength ?? 1600;
    this.allowedToPattern =
      options?.allowedToPattern ?? /^\+[1-9][0-9]{7,14}$/;

    if (!provider || typeof provider.sendSms !== "function") {
      throw new TypeError("SmsNotificationService requires a valid SmsProvider");
    }
  }

  async send(to: string, message: string): Promise<SmsSendResult> {
    if (typeof to !== "string" || !to.trim()) {
      return { success: false, error: "Recipient number is required" };
    }

    if (typeof message !== "string" || !message.trim()) {
      return { success: false, error: "SMS message is required" };
    }

    const normalizedTo = to.trim();
    const normalizedMessage = message.trim();

    if (!this.allowedToPattern.test(normalizedTo)) {
      return {
        success: false,
        error:
          "Recipient number must be in E.164 format (example: +12025550123) and cannot contain spaces",
      };
    }

    if (normalizedMessage.length > this.maxLength) {
      return {
        success: false,
        error: `SMS message exceeds max length of ${this.maxLength} characters`,
      };
    }

    try {
      const result = await this.provider.sendSms(normalizedTo, normalizedMessage);

      if (!result || !result.success) {
        return {
          success: false,
          error:
            result?.error ?? "SMS provider failed to deliver message",
        };
      }

      return {
        success: true,
        provider: this.provider.name,
        providerMessageId: result.providerMessageId,
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? `SMS provider exception: ${error.message}`
            : "SMS provider exception",
      };
    }
  }
}

export class InMemorySmsProvider implements SmsProvider {
  name = "in-memory";

  private readonly failOnRecipient: RegExp;

  constructor(failOnRecipient?: RegExp) {
    // Default failure path uses a valid E.164 test number for deterministic failure-mode coverage.
    this.failOnRecipient = failOnRecipient ?? /^\+12000000000$/;
  }

  async sendSms(to: string, message: string): Promise<SmsSendResult> {
    if (this.failOnRecipient.test(to)) {
      return {
        success: false,
        error: "Simulated failure for recipient",
      };
    }

    if (message.includes("__throw__")) {
      throw new Error("Simulated provider exception");
    }

    return {
      success: true,
      providerMessageId: `msg-${Date.now()}`,
    };
  }
}
