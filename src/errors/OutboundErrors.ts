import { AppError } from "./AppError.js";

/**
 * OutboundTimeoutError
 * Maps to HTTP 504 Gateway Timeout
 * Used when an outbound call to an external service times out.
 */
export class OutboundTimeoutError extends AppError {
  constructor(service?: string) {
    const message = service 
      ? `Request to ${service} timed out` 
      : "Outbound request timed out";
    super(message, 504, "OUTBOUND_TIMEOUT", true);
  }
}

/**
 * OutboundUnavailableError
 * Maps to HTTP 503 Service Unavailable
 * Used when an external service is unavailable after retries.
 */
export class OutboundUnavailableError extends AppError {
  constructor(service?: string) {
    const message = service 
      ? `${service} is currently unavailable` 
      : "External service is currently unavailable";
    super(message, 503, "OUTBOUND_UNAVAILABLE", true);
  }
}

/**
 * OutboundBadResponseError
 * Maps to HTTP 502 Bad Gateway or 400 depending on context
 * Used for non-retryable 4xx/invalid payload from upstream.
 */
export class OutboundBadResponseError extends AppError {
  constructor(service: string, details?: string) {
    const message = `Invalid response from ${service}${details ? `: ${details}` : ""}`;
    super(message, 502, "OUTBOUND_BAD_RESPONSE", true);
  }
}
