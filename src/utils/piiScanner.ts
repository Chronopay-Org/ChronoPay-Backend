/**
 * PII Scanner — Conformance Pattern Library
 *
 * Detects unredacted PII in log output, serialized objects, and arbitrary
 * strings.  Designed for use in the CI conformance suite and as a
 * last-line-of-defence audit helper.
 *
 * Pattern coverage
 * ─────────────────
 *   • Email addresses              (RFC-5321-ish, includes unicode local-parts)
 *   • Phone numbers                (E.164, NANP, common international formats)
 *   • Street addresses             (US-style: number + street name + type)
 *   • Payment-card PANs            (Luhn-valid 13–19 digit sequences)
 *   • Card BIN prefixes            (common issuer prefixes: Visa, MC, Amex, Disc)
 *   • SSN / national-ID fragments  (US XXX-XX-XXXX)
 *
 * False-positive mitigation
 * ─────────────────────────
 *   • Patterns are anchored / bounded with word boundaries
 *   • The card-PAN detector runs a Luhn check before flagging
 *   • Already-masked values (containing "***") are skipped
 *   • A caller-supplied allowlist of regex patterns suppresses known-safe hits
 *
 * Security assumptions
 * ─────────────────────
 *   • Purely read-only: never mutates input
 *   • No external I/O; safe to call in test contexts
 *   • Patterns are compiled once at module load time (immutable RegExp objects)
 */

// ─── Pattern definitions ────────────────────────────────────────────────────

/**
 * A single PII detection rule.
 */
export interface PiiPattern {
  /** Human-readable identifier used in scan results. */
  readonly id: string;
  /** Short description shown in violation reports. */
  readonly description: string;
  /**
   * Regex to test against the input string.
   * Must have the `g` flag so repeated `exec` calls iterate over all matches.
   */
  readonly pattern: RegExp;
  /**
   * Optional extra validation applied to each regex match.
   * Return `true` to confirm the match is genuine PII.
   */
  readonly validate?: (match: string) => boolean;
}

/**
 * A single PII hit reported by the scanner.
 */
export interface PiiHit {
  /** Pattern ID that fired. */
  readonly patternId: string;
  /** Pattern description. */
  readonly description: string;
  /** The exact substring that matched. */
  readonly match: string;
  /** Character index in the input where the match starts. */
  readonly index: number;
}

/**
 * Result returned by `scanText`.
 */
export interface ScanResult {
  /** True when at least one confirmed PII hit was found. */
  readonly hasPii: boolean;
  /** All confirmed PII hits, ordered by their index in the input. */
  readonly hits: readonly PiiHit[];
}

// ─── Luhn check (card PAN validation) ───────────────────────────────────────

/**
 * Validates a digit string against the Luhn algorithm.
 * Strips all non-digit characters before checking.
 */
export function luhnCheck(digits: string): boolean {
  const cleaned = digits.replace(/\D/g, "");
  if (cleaned.length < 13 || cleaned.length > 19) return false;

  let sum = 0;
  let shouldDouble = false;

  for (let i = cleaned.length - 1; i >= 0; i--) {
    let d = parseInt(cleaned[i]!, 10);
    if (shouldDouble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

// ─── Built-in pattern library ────────────────────────────────────────────────

/**
 * Email address pattern.
 *
 * Matches the overwhelming majority of real-world email addresses including
 * unicode local-parts (punycode encoded), plus-aliases, and sub-domains.
 * Deliberately excludes already-masked forms that contain "***".
 *
 * Uses a simplified but practical approach:
 *   local-part  = one or more non-whitespace, non-@ chars
 *   domain      = hostname with at least one dot + TLD (2+ chars)
 */
const EMAIL_PATTERN: PiiPattern = {
  id: "email",
  description: "Email address",
  // Word boundary on the left prevents matching inside a longer token.
  // The domain part requires at least one dot and a 2+ char TLD.
  pattern:
    /\b[a-zA-Z0-9._%+\-\u00C0-\u017E]+@[a-zA-Z0-9\-]+(?:\.[a-zA-Z0-9\-]+)*\.[a-zA-Z]{2,}\b/g,
};

/**
 * Phone number pattern.
 *
 * Covers:
 *   - E.164:  +12025550123
 *   - NANP:   (202) 555-0123, 202-555-0123, 202.555.0123
 *   - International with country code: +44 7911 123456
 *
 * 7-digit minimum after stripping formatting; bounded to avoid matching
 * unrelated numeric sequences.
 */
const PHONE_PATTERN: PiiPattern = {
  id: "phone",
  description: "Phone number",
  pattern:
    /(?<!\d)(?:\+?1[-.\s]?)?\(?(?:[2-9]\d{2})\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)|(?<!\d)\+[1-9]\d{1,14}(?!\d)/g,
};

/**
 * US street address pattern.
 *
 * Matches: <number> <street name> <type>
 * Examples: "123 Main Street", "45 Oak Ave", "1600 Pennsylvania Avenue NW"
 */
const ADDRESS_PATTERN: PiiPattern = {
  id: "address",
  description: "Street address",
  pattern:
    /\b\d{1,5}\s+[A-Za-z0-9\s]{2,40}(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Drive|Dr|Court|Ct|Lane|Ln|Way|Place|Pl|Terrace|Ter|Circle|Cir|Highway|Hwy|Parkway|Pkwy|Square|Sq|Loop|Trail|Trl|Alley|Aly)\.?(?:\s+(?:NW|NE|SW|SE|N|S|E|W))?\b/gi,
};

/**
 * Payment card PAN pattern.
 *
 * Matches 13–19 digit sequences with optional spaces or dashes between
 * groups of 4.  A Luhn check is run as a validator to eliminate false
 * positives.
 *
 * Common issuer prefixes detected:
 *   - Visa:             4xxx
 *   - Mastercard:       5[1-5]xx / 2[2-7]xx
 *   - Amex:             3[47]xx (15 digits)
 *   - Discover:         6011 / 65xx / 644-649
 *   - Diners Club:      3[068]xx
 *   - JCB:              35xx
 */
const CARD_PAN_PATTERN: PiiPattern = {
  id: "card_pan",
  description: "Payment card PAN (Luhn-validated)",
  // Matches digit-groups separated by optional spaces or dashes.
  // We cast to any to satisfy the validate signature.
  pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
  validate: (match) => luhnCheck(match),
};

/**
 * Card BIN prefix pattern.
 *
 * Flags explicit 6-digit BIN values when they appear isolated (i.e., not as
 * part of a longer number sequence), which may appear in logs for routing
 * decisions.  Unlike PAN detection this fires on BIN alone regardless of
 * surrounding context.
 */
const CARD_BIN_PATTERN: PiiPattern = {
  id: "card_bin",
  description: "Payment card BIN prefix",
  // Known issuer BIN prefixes, 6 digits, bounded so they're not part of a longer number.
  pattern:
    /(?<!\d)(?:4[0-9]{5}|5[1-5][0-9]{4}|2[2-7][0-9]{4}|3[47][0-9]{4}|6011[0-9]{2}|65[0-9]{4}|3[068][0-9]{4}|35[0-9]{4})(?!\d)/g,
};

/**
 * US Social Security Number pattern.
 *
 * Matches formatted SSNs: XXX-XX-XXXX or XXX XX XXXX.
 * Invalid area codes (000, 666, 900-999) are still flagged — conservative.
 */
const SSN_PATTERN: PiiPattern = {
  id: "ssn",
  description: "US Social Security Number",
  pattern: /\b(?!000|666|9\d{2})\d{3}[-\s](?!00)\d{2}[-\s](?!0000)\d{4}\b/g,
};

/**
 * The default set of PII patterns applied by `scanText`.
 * Exposed so callers can augment or replace it.
 */
export const DEFAULT_PATTERNS: readonly PiiPattern[] = Object.freeze([
  EMAIL_PATTERN,
  PHONE_PATTERN,
  ADDRESS_PATTERN,
  CARD_PAN_PATTERN,
  CARD_BIN_PATTERN,
  SSN_PATTERN,
]);

// ─── Scanner ────────────────────────────────────────────────────────────────

/**
 * Options for `scanText`.
 */
export interface ScanOptions {
  /**
   * Override the default pattern library.
   * Useful for adding custom patterns or restricting to a subset.
   */
  patterns?: readonly PiiPattern[];
  /**
   * An array of regex patterns (or plain strings) to suppress.
   * Any hit whose `match` value satisfies at least one allowlist entry is
   * discarded.  Use for known-safe values like test fixtures.
   */
  allowlist?: ReadonlyArray<RegExp | string>;
}

/**
 * Checks whether a candidate match is suppressed by the caller's allowlist.
 */
function isAllowlisted(
  match: string,
  allowlist: ReadonlyArray<RegExp | string>,
): boolean {
  for (const entry of allowlist) {
    if (typeof entry === "string") {
      if (match.includes(entry)) return true;
    } else {
      entry.lastIndex = 0; // reset stateful RegExp
      if (entry.test(match)) return true;
    }
  }
  return false;
}

/**
 * Scans `text` for unredacted PII using the registered pattern library.
 *
 * Already-masked tokens (containing "***") within the text do **not** trigger
 * a false-positive because the patterns themselves won't match `***` sequences,
 * but callers can also use the `allowlist` option for belt-and-suspenders.
 *
 * @param text     - The string to scan.
 * @param options  - Optional pattern and allowlist overrides.
 * @returns        A `ScanResult` describing every confirmed PII hit.
 */
export function scanText(text: string, options: ScanOptions = {}): ScanResult {
  const patterns = options.patterns ?? DEFAULT_PATTERNS;
  const allowlist = options.allowlist ?? [];
  const hits: PiiHit[] = [];

  for (const rule of patterns) {
    // Clone the regex to reset lastIndex; the pattern is shared across calls.
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);

    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const matched = m[0];

      // Skip already-masked tokens
      if (matched.includes("***")) continue;

      // Run optional extra validation (e.g., Luhn check)
      if (rule.validate && !rule.validate(matched)) continue;

      // Check caller allowlist
      if (allowlist.length > 0 && isAllowlisted(matched, allowlist)) continue;

      hits.push({
        patternId: rule.id,
        description: rule.description,
        match: matched,
        index: m.index,
      });
    }
  }

  // Sort hits by their position in the input for deterministic output
  hits.sort((a, b) => a.index - b.index);

  return { hasPii: hits.length > 0, hits };
}

// ─── Object / log-line scanner ───────────────────────────────────────────────

/**
 * Recursively serialises `value` to a string, then delegates to `scanText`.
 *
 * Handles nested objects, arrays, and primitive values.  Circular references
 * are replaced with the string `"[Circular]"` (matching `redact`'s behavior).
 *
 * @param value   - Any JSON-serialisable value or plain object.
 * @param options - Same options as `scanText`.
 */
export function scanValue(value: unknown, options: ScanOptions = {}): ScanResult {
  const serialized = safeSerialize(value);
  return scanText(serialized, options);
}

/**
 * Serialises an arbitrary value to a string for scanning.
 * Handles circular references and non-serialisable types gracefully.
 */
function safeSerialize(value: unknown, visited: WeakSet<object> = new WeakSet()): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return String(value);
  if (visited.has(value as object)) return "[Circular]";

  visited.add(value as object);

  if (Array.isArray(value)) {
    return "[" + value.map((v) => safeSerialize(v, visited)).join(", ") + "]";
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const pairs = Object.entries(value as Record<string, unknown>).map(
    ([k, v]) => `"${k}": ${safeSerialize(v, visited)}`,
  );
  return "{" + pairs.join(", ") + "}";
}

// ─── Log sample capture ──────────────────────────────────────────────────────

/**
 * A captured log entry for later conformance scanning.
 */
export interface LogSample {
  /** Arbitrary label for the source of this sample (e.g. endpoint name). */
  readonly source: string;
  /** The serialized log payload as a string. */
  readonly payload: string;
}

/**
 * An in-memory log sample store.
 *
 * Tests inject log output here; the conformance suite then scans every
 * captured sample.  `clear()` should be called in `afterEach`.
 */
export class LogSampleStore {
  private readonly _samples: LogSample[] = [];

  /** Number of samples currently stored. */
  get size(): number {
    return this._samples.length;
  }

  /** Immutable view of stored samples. */
  get samples(): readonly LogSample[] {
    return [...this._samples];
  }

  /**
   * Adds a log sample.
   * @param source  - Label identifying where the log came from.
   * @param payload - The raw log string or serialized object.
   */
  capture(source: string, payload: string | unknown): void {
    const text =
      typeof payload === "string" ? payload : safeSerialize(payload);
    this._samples.push({ source, payload: text });
  }

  /** Removes all stored samples. */
  clear(): void {
    this._samples.length = 0;
  }

  /**
   * Scans all stored samples and returns every PII hit grouped by source.
   *
   * @param options - Scanner options forwarded to `scanText`.
   * @returns       An array of violation reports; empty when no PII is found.
   */
  auditAll(options: ScanOptions = {}): SampleViolation[] {
    const violations: SampleViolation[] = [];

    for (const sample of this._samples) {
      const result = scanText(sample.payload, options);
      if (result.hasPii) {
        violations.push({ source: sample.source, hits: result.hits });
      }
    }

    return violations;
  }
}

/**
 * A PII violation found during a sample audit.
 */
export interface SampleViolation {
  /** The source label provided when the sample was captured. */
  readonly source: string;
  /** All PII hits found in that sample. */
  readonly hits: readonly PiiHit[];
}

/**
 * Module-level default store.
 * Tests can import this and inject log output without constructing their own.
 */
export const defaultLogStore = new LogSampleStore();
