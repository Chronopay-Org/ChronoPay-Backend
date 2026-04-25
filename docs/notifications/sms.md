# SMS Notifications

## Overview

ChronoPay sends SMS notifications through a provider abstraction that supports multiple backends, automatic failover, bounded retries, and strict phone number redaction in all logs.

## Architecture

```
SmsNotificationService
  ├── Input validation (E.164 format, length)
  ├── Failover loop (ordered provider list)
  │   └── RetryPolicy (per provider, transient errors only)
  │       ├── TwilioSmsProvider
  │       ├── VonageSmsProvider
  │       └── InMemorySmsProvider  ← dev/test
  └── redactPhone() applied to all log output
```

## Provider interface

```ts
interface SmsProvider {
  readonly name: string;
  sendSms(to: string, message: string): Promise<SmsSendResult>;
}
```

Any class implementing this interface can be registered as a provider.

## Error classification

| Error type | Retried? | Fails over? |
|---|---|---|
| Network / transient (`Error`) | Yes | Yes (after retries exhausted) |
| `PermanentSmsError` | No | Yes (immediately) |
| Provider returns `{ success: false }` | No | Yes (immediately) |

Throw `PermanentSmsError` from a provider when the failure is definitively non-retryable (e.g. invalid destination number, account suspended).

## Failover

Providers are tried in the order they appear in `SMS_PROVIDERS`. If a provider exhausts its retry budget or returns a permanent failure, the service moves to the next provider. The first successful result is returned.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `SMS_PROVIDERS` | No | Comma-separated ordered list of providers. Default: `in-memory` |
| `TWILIO_ACCOUNT_SID` | When `twilio` listed | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | When `twilio` listed | Twilio Auth Token |
| `TWILIO_FROM_NUMBER` | When `twilio` listed | Sender number in E.164 format |
| `VONAGE_API_KEY` | When `vonage` listed | Vonage API key |
| `VONAGE_API_SECRET` | When `vonage` listed | Vonage API secret |
| `VONAGE_FROM_NAME` | When `vonage` listed | Sender name or number |

### Examples

```bash
# Development (default)
SMS_PROVIDERS=in-memory

# Production with Twilio primary, Vonage fallback
SMS_PROVIDERS=twilio,vonage
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_FROM_NUMBER=+15005550006
VONAGE_API_KEY=your_key
VONAGE_API_SECRET=your_secret
VONAGE_FROM_NAME=ChronoPay
```

Missing required variables cause a startup failure with an aggregated error message. No partial startup occurs.

## API endpoint

```
POST /api/v1/notifications/sms
Content-Type: application/json

{
  "to": "+12025550123",
  "message": "Your booking is confirmed."
}
```

### Success response (200)

```json
{
  "success": true,
  "provider": "twilio",
  "providerMessageId": "SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

### Error responses

| Status | Cause |
|---|---|
| `400` | Missing `to` or `message` field |
| `502` | All providers failed to deliver |

## Security

### Phone number redaction

`redactPhone()` in `src/utils/redact.ts` masks all digits except the last two before any log or warning output:

```
+12025550123  →  +*********23
+447911123456 →  +**********56
```

This is applied in `SmsNotificationService._sendWithFailover` before every `console.warn` call. Raw phone numbers never appear in logs.

### Credential handling

- Provider credentials are read from environment variables at startup.
- Validation errors name the missing variable but never echo its value.
- Credentials are not logged at any log level.

## Adding a new provider

1. Implement `SmsProvider`:

```ts
export class AcmeSmsProvider implements SmsProvider {
  readonly name = "acme";

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new PermanentSmsError("AcmeSmsProvider: missing apiKey");
  }

  async sendSms(to: string, message: string): Promise<SmsSendResult> {
    // call Acme REST API …
    return { success: true, providerMessageId: response.id };
  }
}
```

2. Add a case to `buildProviders()` in `smsNotification.ts`.

3. Add env var validation in `parseSmsConfig()` in `env.ts`.

4. Add `"acme"` to `KNOWN_PROVIDERS` in `env.ts`.

## Testing

```bash
npm test -- --testPathPattern="smsNotification"
```

Test coverage includes:

- Input validation (missing fields, bad format, length)
- Normal send via in-memory provider
- Failover when primary provider throws
- Failover when primary provider returns `{ success: false }`
- All providers failing
- `PermanentSmsError` stops retries but still fails over
- Retry budget respected (`maxRetries` calls before failover)
- `redactPhone` output format
- `isRetryable` classification
- `buildProviders` factory (valid config, missing config, unknown name)
- `loadEnvConfig` SMS validation (defaults, multi-provider, missing creds, unknown provider, error aggregation)
- HTTP API (200, 400, 502)
