import { isFieldRedacted, getPolicyFields } from "./redactionPolicy.js";

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
 * - Hot-reloadable policy via redactionPolicy.ts
 */

/**
 * PII field names that are always redacted, on top of whatever the
 * hot-reloadable policy in redactionPolicy.ts currently contains.
 *
 * Secret/credential field names (passwords, tokens, API keys) come from the
 * policy alone, so an admin reload can add or drop them. PII is deliberately
 * not part of that contract: an admin policy reload must never be able to
 * un-redact personal data, so these names are applied as a fixed overlay.
 *
 * Includes common variations; matching is case-insensitive.
 */
const _PII_FIELDS = new Set([
  "email",
  "phone",
  "ssn",
  "social_security",
  "socialsecurity",
  "dob",
  "date_of_birth",
  "dateofbirth",
  "passport",
  "passport_number",
  "passportnumber",
  "driver_license",
  "driverslicense",
  "driverlicense",
  "tax_id",
  "taxid",
  "national_id",
  "nationalid",
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
 * Auth-token spellings that are always masked. These are kept outside the
 * hot-reloadable policy because they are credentials rather than PII and the
 * historical contract did not include every casing variant.
 */
const _AUTH_TOKEN_FIELDS = new Set(["auth_token", "authtoken"]);

/**
 * Checks if a field name should be redacted (case-insensitive)
 * Reads from the current hot-reloadable policy.
 */
const isSensitiveField = (fieldName: string): boolean => {
  const normalized = fieldName.toLowerCase();
  return (
    _PII_FIELDS.has(normalized) ||
    _AUTH_TOKEN_FIELDS.has(normalized) ||
    isFieldRedacted(normalized)
  );
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

type UnknownRecord = Record<string, unknown>;

const CIRCULAR_REFERENCE = "[Circular]";

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

/**
 * Identifies records we can safely walk. Uses toString instead of a
 * constructor check to avoid cross-realm issues (e.g., structuredClone in
 * Jest's VM sandbox creates objects with a different Object constructor).
 * Other built-ins keep their previous pass-through behavior.
 */
const isRecordObject = (value: object): boolean =>
  Object.prototype.toString.call(value) === "[object Object]";

/**
 * Redacts a single key/value pair from an object-like container.
 * Nested objects are always walked first so their sensitive fields are
 * masked; only primitive values under a sensitive key are replaced.
 */
const redactProperty = (
  key: string,
  value: unknown,
  visited: WeakSet<object>,
): unknown => {
  if (isObject(value) && !(value instanceof Date)) {
    return redactValue(value, visited);
  }
  if (isSensitiveField(key)) {
    return maskValue(value);
  }
  return value;
};

const redactArray = (value: unknown[], visited: WeakSet<object>): unknown[] =>
  value.map((item) => redactValue(item, visited));

const redactMap = (
  value: ReadonlyMap<unknown, unknown>,
  visited: WeakSet<object>,
): Map<unknown, unknown> => {
  const redacted = new Map<unknown, unknown>();

  for (const [key, entryValue] of value) {
    const redactedKey = isObject(key) ? redactValue(key, visited) : key;
    const redactedValue =
      typeof key === "string"
        ? redactProperty(key, entryValue, visited)
        : redactValue(entryValue, visited);
    redacted.set(redactedKey, redactedValue);
  }

  return redacted;
};

const redactSet = (
  value: ReadonlySet<unknown>,
  visited: WeakSet<object>,
): Set<unknown> => {
  const redacted = new Set<unknown>();

  for (const member of value) {
    redacted.add(redactValue(member, visited));
  }

  return redacted;
};

const redactError = (error: Error, visited: WeakSet<object>): Error => {
  // Preserve the original prototype so instanceof checks keep working.
  const redacted = Object.create(Object.getPrototypeOf(error)) as Error;
  const target = redacted as unknown as UnknownRecord;
  const source = error as unknown as UnknownRecord;

  for (const key of ["name", "message", "stack"] as const) {
    const property = source[key];
    if (typeof property === "string") {
      target[key] = property;
    }
  }

  if ("cause" in error) {
    target.cause = redactProperty("cause", source.cause, visited);
  }

  // Own enumerable properties include custom fields attached to the error.
  for (const key of Object.keys(error)) {
    if (key === "cause") {
      continue;
    }
    target[key] = redactProperty(key, source[key], visited);
  }

  return redacted;
};

const redactRecord = (
  record: UnknownRecord,
  visited: WeakSet<object>,
): UnknownRecord => {
  // Preserve class instances (prototype methods/getters) while walking only
  // own enumerable properties.
  const redacted = Object.create(
    Object.getPrototypeOf(record),
  ) as UnknownRecord;

  for (const key of Object.keys(record)) {
    redacted[key] = redactProperty(key, record[key], visited);
  }

  return redacted;
};

const redactValue = (value: unknown, visited: WeakSet<object>): unknown => {
  // Handle null, undefined and primitives
  if (!isObject(value)) {
    return value;
  }

  // Dates and regular expressions are immutable containers with no loggable
  // own fields; keep the original reference.
  if (value instanceof Date || value instanceof RegExp) {
    return value;
  }

  // Handle circular references
  if (visited.has(value)) {
    return CIRCULAR_REFERENCE;
  }

  // Mark this object as visited before recursing into its children
  visited.add(value);

  if (Array.isArray(value)) {
    return redactArray(value, visited);
  }

  if (value instanceof Map) {
    return redactMap(value, visited);
  }

  if (value instanceof Set) {
    return redactSet(value, visited);
  }

  if (value instanceof Error) {
    return redactError(value, visited);
  }

  if (isRecordObject(value)) {
    return redactRecord(value as UnknownRecord, visited);
  }

  // For other object types, return as-is
  return value;
};

/**
 * Recursively redacts sensitive data from an object
 *
 * @param value - The value to redact
 * @param visited - Set of objects already visited (for circular reference detection)
 * @returns A new value of the same type with sensitive fields masked
 */
export const redact = <T>(
  value: T,
  visited: WeakSet<object> = new WeakSet(),
): T => {
  return redactValue(value, visited) as T;
};

/**
 * Checks if a value would be redacted
 * Useful for testing and validation.
 * Reads from the current hot-reloadable policy.
 */
export const wouldBeRedacted = (fieldName: string): boolean => {
  return isSensitiveField(fieldName);
};

/**
 * Gets the list of field names redacted by the current hot-reloadable policy.
 * PII is applied on top of this list and is therefore not reported here.
 */
export const getSensitiveFields = (): string[] => {
  return getPolicyFields();
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
 * Redacts a phone number for secure logging.
 *
 * Keeps at most the first character (the `+` of E.164 numbers, or the first
 * digit) and, for international numbers, the last two digits. Every other
 * character is replaced with `*` so the masked output has the same length as
 * the input, which keeps its width from leaking the number's real formatting.
 *
 * @param phone - The phone number to redact (E.164 format expected)
 * @returns Redacted phone number (e.g., "+*********23")
 */
export const redactPhone = (phone: string): string => {
  if (!phone || typeof phone !== "string") {
    return "***";
  }

  const trimmed = phone.trim();

  if (trimmed.length <= 1) {
    return "***";
  }

  const isInternational = trimmed.startsWith("+");
  const body = trimmed.substring(1);

  // Only reveal trailing digits for international numbers, and only when
  // there is something left to mask in front of them.
  const visibleTail = isInternational && body.length > 2 ? body.slice(-2) : "";
  const maskedLength = body.length - visibleTail.length;

  return `${trimmed[0]}${"*".repeat(maskedLength)}${visibleTail}`;
};
