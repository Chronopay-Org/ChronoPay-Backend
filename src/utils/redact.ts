/**
 * Redaction Utility for Secure Logging
 *
 * Strips sensitive data from objects before logging to ensure secrets
 * (tokens, passwords, API keys, etc.) never reach logs.
 *
 * Features:
 * - Handles nested objects and arrays at any depth
 * - Case-insensitive key matching
 * - Non-mutating: creates a new object
 * - Circular reference detection
 * - Preserves original data structure and types
 */

/**
 * Sensitive field names that should be redacted
 * Includes common variations and case-insensitive matches
 */
const SENSITIVE_FIELDS = new Set([
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "session",
  "privatekey",
  "private_key",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "bearer",
  "x-api-key",
  "api-key",
  "app_secret",
  "appsecret",
  "client_secret",
  "clientsecret",
  "signing_key",
  "signingkey",
  "hmac",
  "jwt",
  "aws_secret",
  "awssecret",
  "database_url",
  "databaseurl",
  "db_password",
  "dbpassword",
  "encryption_key",
  "encryptionkey",
  "webhook_secret",
  "webhooksecret",
  "oauth_token",
  "oauthtoken",
  "auth_code",
  "authcode",
  "cardtoken",
  "card_token",
  "tracking_token",
  "trackingtoken",
]);

/**
 * Default mask pattern for redacted values
 * Shows first 2 and last 2 characters, hides middle
 */
const DEFAULT_MASK_PATTERN = (value: string): string => {
  if (value.length < 5) {
    return "***";
  }
  return `${value.substring(0, 2)}***${value.substring(value.length - 2)}`;
};

/**
 * Checks if a field name should be redacted (case-insensitive)
 */
const isSensitiveField = (fieldName: string): boolean => {
  return SENSITIVE_FIELDS.has(fieldName.toLowerCase());
};

/**
 * Masks a sensitive value
 */
const maskValue = (value: unknown): string => {
  if (typeof value === "string") {
    return DEFAULT_MASK_PATTERN(value);
  }
  return "***";
};

/**
 * Recursively redacts sensitive data from an object
 *
 * @param obj - The object to redact (or any value)
 * @param visited - Set of objects already visited (for circular reference detection)
 * @returns A new object with sensitive fields masked
 */
export const redact = (
  obj: unknown,
  visited: WeakSet<any> = new WeakSet()
): unknown => {
  // Handle null and undefined
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Handle primitives
  if (typeof obj !== "object") {
    return obj;
  }

  // Handle circular references
  if (visited.has(obj)) {
    return "[Circular]";
  }

  // Mark this object as visited
  visited.add(obj);

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => redact(item, visited));
  }

  // Handle Date objects
  if (obj instanceof Date) {
    return obj;
  }

  // Handle plain objects
  if (obj.constructor === Object) {
    const redacted: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      // Always recurse into nested objects/arrays first
      if (typeof value === "object" && value !== null && !(value instanceof Date)) {
        redacted[key] = redact(value, visited);
      } else if (isSensitiveField(key)) {
        // Redact sensitive primitive values
        redacted[key] = maskValue(value);
      } else {
        // Keep non-sensitive primitive values as-is
        redacted[key] = value;
      }
    }

    return redacted;
  }

  // For other object types, return as-is
  return obj;
};

/**
 * Checks if a value would be redacted
 * Useful for testing and validation
 */
export const wouldBeRedacted = (fieldName: string): boolean => {
  return isSensitiveField(fieldName);
};

/**
 * Gets the list of all recognized sensitive field names
 */
export const getSensitiveFields = (): string[] => {
  return Array.from(SENSITIVE_FIELDS);
};

/**
 * Sanitizes a note string by removing control characters, normalizing unicode,
 * and trimming whitespace.
 *
 * - Removes null bytes and control characters (0x00-0x1F) except tab, newline, CR
 * - Removes C1 control characters (0x80-0x9F)
 * - Normalizes unicode to NFC form
 * - Trims leading/trailing whitespace
 * - Returns null if the result is empty
 *
 * Allowed control characters: \t (0x09), \n (0x0A), \r (0x0D)
 */
export const sanitizeNote = (note: string): string | null => {
  let cleaned = "";
  for (const ch of note) {
    const code = ch.charCodeAt(0);
    const isAllowedC0 = code === 0x09 || code === 0x0a || code === 0x0d;
    const isControl = code < 0x20 && !isAllowedC0;
    const isC1Control = code >= 0x80 && code <= 0x9f;
    if (!isControl && !isC1Control) {
      cleaned += ch;
    }
  }
  cleaned = cleaned.normalize("NFC").trim();
  return cleaned.length === 0 ? null : cleaned;
};

/**
 * Redacts a phone number for secure logging
 * Shows country code and last 4 digits, masks the rest
 *
 * @param phone - The phone number to redact (E.164 format expected)
 * @returns Redacted phone number (e.g., "+1***50123")
 */
export const redactPhone = (phone: string): string => {
  if (!phone || typeof phone !== "string") {
    return "***";
  }

  const trimmed = phone.trim();

  if (trimmed.length < 8) {
    return "***";
  }

  // Show country code (e.g., +1) and last 4 digits
  const countryCode = trimmed.substring(0, 2);
  const lastDigits = trimmed.substring(trimmed.length - 4);
  return `${countryCode}***${lastDigits}`;
};
