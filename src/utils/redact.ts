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
