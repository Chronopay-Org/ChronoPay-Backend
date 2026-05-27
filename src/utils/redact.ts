/**
 * Redacts a phone number for safe logging.
 * Keeps the leading '+' and last 2 digits; masks everything in between.
 *
 * Examples:
 *   +12025550123  →  +*********23
 *   +447911123456 →  +**********56
 */
export function redactPhone(phone: string): string {
  if (!phone.startsWith("+") || phone.length < 4) {
    return phone.length > 1 ? phone[0] + "*".repeat(phone.length - 1) : "***";
  }
  const digits = phone.slice(1); // strip leading '+'
  const last2 = digits.slice(-2);
  const masked = "*".repeat(digits.length - 2);
  return `+${masked}${last2}`;
}

/**
 * Sanitizes a note field by stripping control characters and normalizing unicode.
 *
 * This function:
 * - Removes C0 control characters (0x00-0x1F) except tab (0x09), newline (0x0A), and carriage return (0x0D)
 * - Removes C1 control characters (0x80-0x9F)
 * - Normalizes unicode to NFC form
 * - Trims whitespace
 *
 * @param note - The note string to sanitize
 * @returns The sanitized note string, or null if the note is empty after sanitization
 *
 * @example
 * sanitizeNote("Hello\x00World") // "HelloWorld"
 * sanitizeNote("Café\u0301") // "Café" (NFC normalized)
 * sanitizeNote("  \t\n  ") // null (empty after sanitization)
 */
export function sanitizeNote(note: string): string | null {
  // Remove C0 control characters except tab, newline, carriage return
  let sanitized = note.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  // Remove C1 control characters (0x80-0x9F)
  sanitized = sanitized.replace(/[\x80-\x9F]/g, "");
  // Normalize unicode to NFC
  sanitized = sanitized.normalize("NFC");
  // Trim whitespace
  sanitized = sanitized.trim();
  
  // Return null if empty after sanitization
  return sanitized.length === 0 ? null : sanitized;
}
