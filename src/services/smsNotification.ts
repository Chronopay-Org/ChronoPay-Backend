import { withTimeout, withRetry } from "../utils/outbound-helper.js";
import { timeoutConfig } from "../config/timeouts.js";
import { OutboundBadResponseError } from "../errors/OutboundErrors.js";

export interface SmsSendResult {
  success: boolean;
  provider?: string;
  providerMessageId?: string;
  error?: string;
  statusCode?: number;
}

/** Thrown by providers to signal a permanent (non-retryable) failure. */
export class PermanentSmsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentSmsError";
  }
}

// ─── Provider interface ──────────────────────────────────────────────────────

export interface SmsProvider {
  name: string;
  sendSms(to: string, message: string, signal?: AbortSignal): Promise<SmsSendResult>;
}

// ─── Retry / failover helpers ────────────────────────────────────────────────

/** Returns true when the error is transient and a retry makes sense. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof PermanentSmsError) return false;
  // Network-level errors and unknown exceptions are retryable
  return true;
}

// ─── Service options ─────────────────────────────────────────────────────────

export interface SmsOptions {
  maxLength?: number;
  allowedToPattern?: RegExp;
  /** Ordered list of providers; first healthy one wins. */
  providers?: SmsProvider[];
  retryPolicy?: RetryPolicy;
}

// ─── Main service ─────────────────────────────────────────────────────────────

export class SmsNotificationService {
  private readonly providers: SmsProvider[];
  private readonly maxLength: number;
  private readonly allowedToPattern: RegExp;
  private readonly retry: RetryPolicy;

  constructor(
    /** Primary provider (kept for backwards-compat single-provider usage). */
    primaryProvider: SmsProvider,
    options?: SmsOptions,
  ) {
    if (!primaryProvider || typeof primaryProvider.sendSms !== "function") {
      throw new TypeError("SmsNotificationService requires a valid SmsProvider");
    }

    this.providers = options?.providers?.length
      ? options.providers
      : [primaryProvider];

    this.maxLength = options?.maxLength ?? 1600;
    this.allowedToPattern = options?.allowedToPattern ?? /^\+[1-9][0-9]{7,14}$/;
    this.retry = options?.retryPolicy ?? new RetryPolicy({ maxRetries: 2, initialDelay: 200, useJitter: false });
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
      const result = await withRetry(
        async (attempt) => {
          return await withTimeout(
            async (signal) => {
              const res = await this.provider.sendSms(normalizedTo, normalizedMessage, signal);
              
              // Map provider errors to internal codes if needed
              if (!res.success && res.statusCode && res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 429) {
                throw new OutboundBadResponseError(this.provider.name, res.error);
              }
              
              return res;
            },
            timeoutConfig.http.smsMs,
            `sms-provider:${this.provider.name}`
          );
        },
        { serviceName: `sms-provider:${this.provider.name}` }
      );

        // Provider returned a non-throwing failure — treat as permanent for this provider
        lastError = result.error ?? "Provider returned failure";
      } catch (err) {
        // All retries exhausted for this provider — try next
        lastError = err instanceof Error ? err.message : String(err);
        console.warn(
          `[SMS] Provider "${provider.name}" failed for ${redactPhone(to)}: ${lastError}`,
        );
      }
    }

      return {
        success: true,
        provider: this.provider.name,
        providerMessageId: result.providerMessageId,
      };
    } catch (error: any) {
      return {
        success: false,
        error:
          error instanceof Error
            ? `SMS provider exception: ${error.message}`
            : "SMS provider exception",
      };
    }
    return result;
  }
}

// ─── Concrete providers ───────────────────────────────────────────────────────

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

/**
 * Twilio provider stub.
 * In production, replace the body of sendSms with the real Twilio REST call.
 */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = "twilio";
  private readonly config: TwilioConfig;

  constructor(config: TwilioConfig) {
    if (!config.accountSid || !config.authToken || !config.fromNumber) {
      throw new PermanentSmsError("TwilioSmsProvider: missing required config");
    }
    this.config = config;
  }

  async sendSms(to: string, message: string): Promise<SmsSendResult> {
    // Real implementation would POST to:
    //   https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
    // using Basic Auth (accountSid:authToken).
    void this.config; // suppress unused-var warning in stub
    void to;
    void message;
    throw new Error("TwilioSmsProvider is a stub — configure a real HTTP client");
  }
}

export interface VonageConfig {
  apiKey: string;
  apiSecret: string;
  fromName: string;
}

/**
 * Vonage (Nexmo) provider stub.
 * In production, replace the body of sendSms with the real Vonage REST call.
 */
export class VonageSmsProvider implements SmsProvider {
  readonly name = "vonage";
  private readonly config: VonageConfig;

  constructor(config: VonageConfig) {
    if (!config.apiKey || !config.apiSecret || !config.fromName) {
      throw new PermanentSmsError("VonageSmsProvider: missing required config");
    }
    this.config = config;
  }

  async sendSms(to: string, message: string): Promise<SmsSendResult> {
    // Real implementation would POST to:
    //   https://rest.nexmo.com/sms/json
    // with apiKey, apiSecret, from, to, text fields.
    void this.config;
    void to;
    void message;
    throw new Error("VonageSmsProvider is a stub — configure a real HTTP client");
  }
}

// ─── In-memory provider (testing / development) ───────────────────────────────

export class InMemorySmsProvider implements SmsProvider {
  readonly name = "in-memory";
  private readonly failOnRecipient: RegExp;

  constructor(failOnRecipient?: RegExp) {
    this.failOnRecipient = failOnRecipient ?? /^\+12000000000$/;
  }

  async sendSms(to: string, message: string, signal?: AbortSignal): Promise<SmsSendResult> {
    if (signal?.aborted) {
      throw new Error("AbortError");
    }

    if (this.failOnRecipient.test(to)) {
      return {
        success: false,
        error: "Simulated failure for recipient",
        statusCode: 400
      };
    }
    if (message.includes("__throw__")) {
      throw new Error("Simulated provider exception");
    }

    if (message.includes("__timeout__")) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 10000);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("AbortError"));
        });
      });
    }

    return {
      success: true,
      providerMessageId: `msg-${Date.now()}`,
    };
  }
}

// ─── Provider registry / factory ─────────────────────────────────────────────

export interface SmsProviderConfig {
  /** Ordered list of provider names to use, e.g. ["twilio", "vonage"] */
  providers: string[];
  twilio?: TwilioConfig;
  vonage?: VonageConfig;
}

/**
 * Builds an ordered list of SmsProvider instances from config.
 * Throws if a requested provider is missing its config.
 */
export function buildProviders(config: SmsProviderConfig): SmsProvider[] {
  return config.providers.map((name) => {
    switch (name) {
      case "twilio":
        if (!config.twilio) throw new Error("Twilio config is required when 'twilio' is listed as a provider");
        return new TwilioSmsProvider(config.twilio);
      case "vonage":
        if (!config.vonage) throw new Error("Vonage config is required when 'vonage' is listed as a provider");
        return new VonageSmsProvider(config.vonage);
      case "in-memory":
        return new InMemorySmsProvider();
      default:
        throw new Error(`Unknown SMS provider: "${name}"`);
    }
  });
}
