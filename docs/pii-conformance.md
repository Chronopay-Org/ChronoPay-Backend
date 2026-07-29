# PII Redaction Conformance Suite

Regressions in the redaction layer can silently leak PII into logs, error
responses, or build artefacts.  This conformance suite provides:

1. A **scanner utility** (`src/utils/piiScanner.ts`) with a pattern library
   covering all regulated PII categories.
2. A **Jest test suite** (`src/__tests__/piiConformance.test.ts`) that
   exercises every pattern and edge case.
3. A **CI script** (`scripts/pii-conformance-scan.ts`) that scans build
   artefacts on every push to `main` and fails the build on any hit.

---

## Pattern library

| Pattern ID  | What it detects                             | Validator           |
|-------------|---------------------------------------------|---------------------|
| `email`     | Email addresses (RFC-5321-ish, unicode)     | regex only          |
| `phone`     | E.164, NANP, common international formats   | regex only          |
| `address`   | US street addresses (number + type)         | regex only          |
| `card_pan`  | Payment card PANs, 13–19 digits             | Luhn check          |
| `card_bin`  | 6-digit BIN prefixes (Visa, MC, Amex, Disc) | regex only          |
| `ssn`       | US SSNs in `XXX-XX-XXXX` or `XXX XX XXXX`  | area-code exclusion |

All patterns are compiled once at module load and are read-only.  They live
in `DEFAULT_PATTERNS` and can be replaced or extended via `ScanOptions`.

---

## Architecture

```
src/utils/piiScanner.ts
│
├── luhnCheck(digits)          Validate a digit string with the Luhn algorithm
│
├── scanText(text, options)    Scan a string; return ScanResult { hasPii, hits }
│
├── scanValue(value, options)  Serialise any value then delegate to scanText
│
├── LogSampleStore             In-memory store: capture(), clear(), auditAll()
│
└── defaultLogStore            Module-level singleton for use in tests
```

### `scanText`

```ts
import { scanText } from "./utils/piiScanner.js";

const result = scanText('User alice@example.com logged in from +12025550123');
// result.hasPii  → true
// result.hits[0] → { patternId: 'email', match: 'alice@example.com', ... }
// result.hits[1] → { patternId: 'phone', match: '+12025550123', ... }
```

### `scanValue`

Accepts any JSON-serialisable value.  Handles circular references and `Date`
objects safely.

```ts
import { scanValue } from "./utils/piiScanner.js";

const r = scanValue({ user: 'alice@example.com', role: 'admin' });
// r.hasPii → true
```

### `LogSampleStore`

Designed for test hooks.  Capture log output during a test, then call
`auditAll()` in an `afterEach` / `afterAll` to assert no PII escaped.

```ts
import { LogSampleStore } from "./utils/piiScanner.js";

const store = new LogSampleStore();

// In your test setup / logger mock:
store.capture('POST /api/v1/users', JSON.stringify(responseBody));

// In afterEach:
const violations = store.auditAll();
expect(violations).toHaveLength(0);

store.clear();
```

---

## Allowlisting known-safe values

Use the `allowlist` option to suppress test fixtures or known-safe strings:

```ts
scanText(logLine, {
  allowlist: [
    'noreply@example.com',   // string exact-include match
    /@example\.com$/,        // RegExp test against each match
  ],
});
```

The allowlist is checked **per hit**: only the specific matched value is
suppressed; other PII in the same string is still reported.

---

## Adding a custom pattern

```ts
import { scanText, type PiiPattern } from "./utils/piiScanner.js";

const INTERNAL_ID: PiiPattern = {
  id: 'internal_id',
  description: 'Internal customer identifier',
  pattern: /CUS-[0-9]{8}/g,
};

const r = scanText('ref: CUS-00001234 processed', {
  patterns: [INTERNAL_ID],   // replaces DEFAULT_PATTERNS for this call
});
```

To *add* a pattern on top of the defaults:

```ts
import { DEFAULT_PATTERNS } from "./utils/piiScanner.js";

scanText(text, { patterns: [...DEFAULT_PATTERNS, INTERNAL_ID] });
```

---

## Running the conformance tests

```bash
# Run just the conformance suite
npx jest src/__tests__/piiConformance.test.ts

# Run with coverage (must hit ≥ 95 % on piiScanner.ts)
npm run test:coverage
```

Expected output (abbreviated):

```
PASS src/__tests__/piiConformance.test.ts
  luhnCheck (9 tests)
  scanText — email (10 tests)
  scanText — phone (9 tests)
  scanText — address (6 tests)
  scanText — card_pan (7 tests)
  scanText — card_bin (6 tests)
  scanText — ssn (6 tests)
  scanText — combined PII (4 tests)
  scanText — encoding edge cases (6 tests)
  scanText — allowlist suppression (5 tests)
  scanValue (10 tests)
  LogSampleStore (9 tests)
  defaultLogStore (3 tests)
  ScanOptions — custom patterns (3 tests)
  false-positive robustness (6 tests)

Tests: 99 passed, 99 total
```

---

## CI integration

The `pii-conformance-scan` step in `.github/workflows/ci.yml` runs after
`npm run build` on every push to `main` (not on PRs, which skip the build):

```yaml
- name: PII conformance scan
  if: github.event_name != 'pull_request'
  run: npm run pii-scan
```

The script (`scripts/pii-conformance-scan.ts`) scans `dist/` and `logs/` for
any file matching `.js`, `.json`, `.log`, or `.txt`.

**Exit codes:**

| Code | Meaning                                   |
|------|-------------------------------------------|
| `0`  | No PII detected — build proceeds          |
| `1`  | PII detected — build fails                |
| `2`  | Scan error (I/O failure, bad arguments)   |

**Sample failure output:**

```
pii-conformance-scan: FAIL — unredacted PII detected!

  2 violation(s) found:

  [email] dist/routes/users.js:42:15
    Description : Email address
    Match       : alice@example.com

  [phone] dist/routes/users.js:43:15
    Description : Phone number
    Match       : +12025550123

  Fix: ensure all PII fields are redacted before logging.
  See docs/pii-conformance.md for guidance.
```

### Running the scan locally

```bash
# Scan default targets (dist/, logs/)
npm run pii-scan

# Scan a specific directory
npm run pii-scan -- --files path/to/logs
```

---

## Security assumptions and limitations

| Assumption | Notes |
|---|---|
| Patterns are read-only after module load | `DEFAULT_PATTERNS` is `Object.freeze`d |
| No external I/O in `piiScanner.ts` | Safe to import in any test environment |
| Already-masked values (`***`) are skipped | The regex patterns cannot match `***` sequences |
| Luhn check reduces card PAN false positives | Random digit sequences very rarely pass Luhn |
| Base64/percent-encoded PII is **not** detected | The scanner operates on the string it receives; callers must decode first |
| Unicode lookalikes (fullwidth `＠`) are **not** detected | Out-of-scope by design; mitigated upstream by input normalisation |

### Known gaps

- **Encoded payloads**: PII encoded as base64, URL-encoding, or unicode
  escapes will not be detected.  Log pipelines that decode payloads before
  persisting them must call `scanText` on the *decoded* form.
- **Non-US addresses**: The address pattern is US-centric.  Extend
  `DEFAULT_PATTERNS` with locale-specific patterns as needed.
- **Tokenised PANs**: A valid-Luhn 16-digit token (e.g. from a payment vault)
  will trigger the `card_pan` pattern.  Add it to the allowlist if it appears
  in legitimate log output.
- **Field-name-based redaction**: `piiScanner.ts` detects PII by *value*
  pattern, not by field name.  It is complementary to, not a replacement for,
  the key-based `redact()` utility in `src/utils/redact.ts`.

---

## Extending the suite

1. Add new `PiiPattern` entries to `DEFAULT_PATTERNS` in `piiScanner.ts`.
2. Write corresponding `it()` blocks in `piiConformance.test.ts` — both
   positive (detects the PII) and negative (does not false-positive on safe
   strings).
3. If the pattern needs custom validation (like Luhn), implement a `validate`
   function alongside the `pattern` regexp.
4. Re-run `npm run test:coverage` to confirm coverage stays ≥ 95 %.
