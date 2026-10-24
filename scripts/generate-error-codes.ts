/**
 * Generates docs/error-codes.md from the error taxonomy.
 *
 * The taxonomy in src/errors/errorCodes.ts (ERROR_TAXONOMY) is the single
 * source of truth for code → status → scope → i18n-key relationships. This
 * script renders the documented reference table from it, so the docs can never
 * drift from the code.
 *
 * Usage: npm run generate:error-docs   (or tsx scripts/generate-error-codes.ts)
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ERROR_TAXONOMY, type ErrorCode, type ErrorType } from "../src/errors/errorCodes.js";

const isMainModule =
  typeof process !== "undefined" && process.argv[1] === fileURLToPath(import.meta.url);

export const DEFAULT_OUTPUT_FILE = "docs/error-codes.md";

const CATEGORY_LABELS: Record<ErrorType["category"], { title: string; sections: string[] }> = {
  validation: { title: "Validation (400 / 422)", sections: ["validation"] },
  authentication: { title: "Authentication (401)", sections: ["authentication"] },
  authorization: { title: "Authorization (400 / 403)", sections: ["authorization"] },
  ratelimit: { title: "Rate limiting (429)", sections: ["ratelimit"] },
  feature: { title: "Feature flags (503)", sections: ["feature"] },
  idempotency: { title: "Idempotency / replay (400 / 409 / 422)", sections: ["idempotency"] },
  content: { title: "Content negotiation (406 / 415)", sections: ["content"] },
  state: { title: "State / lifecycle (404 / 409 / 422)", sections: ["state"] },
  bundle: { title: "Bundles (422)", sections: ["bundle"] },
  budget: { title: "Query budget (503)", sections: ["budget"] },
  infrastructure: { title: "Infrastructure (500 / 503)", sections: ["infrastructure"] },
};

const CODE_ORDER: ErrorCode[] = [
  "BAD_REQUEST",
  "VALIDATION_ERROR",
  "MISSING_REQUIRED_FIELD",
  "INVALID_PAYLOAD",
  "MALFORMED_JSON",
  "UNAUTHORIZED",
  "AUTHENTICATION_REQUIRED",
  "INVALID_TOKEN",
  "INVALID_API_KEY",
  "INVALID_SIGNATURE",
  "INVALID_TIMESTAMP",
  "TIMESTAMP_OUT_OF_SKEW",
  "FORBIDDEN",
  "INSUFFICIENT_PERMISSIONS",
  "INVALID_ROLE",
  "RATE_LIMITED",
  "FEATURE_DISABLED",
  "IDEMPOTENCY_KEY_INVALID",
  "IDEMPOTENCY_IN_PROGRESS",
  "IDEMPOTENCY_KEY_MISMATCH",
  "REPLAY_DETECTED",
  "UNSUPPORTED_MEDIA_TYPE",
  "NOT_ACCEPTABLE",
  "NOT_FOUND",
  "CONFLICT",
  "UNPROCESSABLE_ENTITY",
  "BUNDLE_EXPIRED",
  "BUNDLE_NOT_TRANSFERABLE",
  "QUERY_BUDGET_EXCEEDED",
  "INTERNAL_ERROR",
  "DB_ERROR",
  "SERVICE_UNAVAILABLE",
  "CONFIGURATION_ERROR",
  "FEATURE_FLAG_EVALUATION_ERROR",
];

const CODE_DESCRIPTIONS: Record<ErrorCode, string> = {
  BAD_REQUEST: "Generic malformed request.",
  MISSING_REQUIRED_FIELD: "Required body/query/param field is missing or empty.",
  INVALID_PAYLOAD: "Payload structurally invalid (wrong type, shape).",
  MALFORMED_JSON: "Request body is not valid JSON.",
  VALIDATION_ERROR: "Semantic validation failure (e.g., business rule).",
  UNAUTHORIZED: "Generic authentication failure.",
  AUTHENTICATION_REQUIRED: "Required auth header/token absent.",
  INVALID_TOKEN: "Bearer token malformed, expired, or rejected.",
  INVALID_API_KEY: "API key missing or does not match expected.",
  INVALID_SIGNATURE: "HMAC signature verification failed.",
  INVALID_TIMESTAMP: "HMAC timestamp header is not a finite number.",
  TIMESTAMP_OUT_OF_SKEW: "HMAC timestamp outside the allowed skew window.",
  FORBIDDEN: "Generic authorization failure.",
  INSUFFICIENT_PERMISSIONS: "Authenticated principal lacks the required role.",
  INVALID_ROLE: "Role header present but value is not recognized.",
  RATE_LIMITED: "Caller exceeded the configured request ceiling.",
  FEATURE_DISABLED: "Route guarded behind a flag that is currently off.",
  FEATURE_FLAG_EVALUATION_ERROR: "Flag accessor threw while evaluating the flag.",
  IDEMPOTENCY_KEY_INVALID: "`Idempotency-Key` header malformed.",
  IDEMPOTENCY_IN_PROGRESS: "Another request with the same key is still running.",
  IDEMPOTENCY_KEY_MISMATCH: "Same key reused with a different request payload.",
  REPLAY_DETECTED: "HMAC replay window detected an already-seen signature.",
  UNSUPPORTED_MEDIA_TYPE: "Request `Content-Type` is not `application/json`.",
  NOT_ACCEPTABLE: "Request `Accept` does not include JSON.",
  NOT_FOUND: "Requested resource or route does not exist.",
  CONFLICT: "Request conflicts with current resource state.",
  UNPROCESSABLE_ENTITY: "Request was valid but cannot be processed in current state.",
  BUNDLE_EXPIRED: "Booking bundle has expired and can no longer be used.",
  BUNDLE_NOT_TRANSFERABLE: "Booking bundle cannot be transferred between bookings.",
  QUERY_BUDGET_EXCEEDED: "Request consumed too much database time; retry later.",
  INTERNAL_ERROR: "Unhandled error or unknown exception.",
  DB_ERROR: "Database driver, query, or transaction failure.",
  SERVICE_UNAVAILABLE: "Dependency unavailable; safe to retry.",
  CONFIGURATION_ERROR: "Required configuration (secret, feature, env) is missing.",
};

const HEADER = `# Error Code Taxonomy

ChronoPay API error responses use a single canonical envelope. Every error
response — whether produced by middleware, a route handler, or the global
error handler — emits the same shape, and every error carries a stable
machine-readable \`code\`.

This document is **generated** from \`src/errors/errorCodes.ts\`
(\`npm run generate:error-docs\`). Do not edit the code tables by hand.

## Envelope

\`\`\`json
{
  "success": false,
  "code": "ERROR_CODE",
  "error": "Human-readable explanation.",
  "timestamp": "2026-04-26T12:34:56.789Z",
  "requestId": "req_abc123",
  "details": { /* optional, code-specific */ }
}
\`\`\`

| Field       | Type    | Required | Notes                                                  |
| ----------- | ------- | -------- | ------------------------------------------------------ |
| \`success\`   | boolean | yes      | Always \`false\` for error responses.                    |
| \`code\`      | string  | yes      | Stable identifier from the table below.                |
| \`error\`     | string  | yes      | Human-readable, safe to surface to end users.          |
| \`timestamp\` | string  | yes      | ISO 8601 UTC timestamp.                                |
| \`requestId\` | string  | when set | Correlates with logs; absent if no request id is set.  |
| \`details\`   | object  | no       | Optional, code-specific structured data.               |
| \`stack\`     | string  | dev only | Included only when \`NODE_ENV !== "production"\`.        |

Stack traces are NEVER included in production. Internal/unknown errors are
mapped to \`INTERNAL_ERROR\` with a generic message; the original cause is
written to logs but never returned over the wire.

## Codes
`;

const FOOTER = `## Adding a new code

1. Add the entry to \`src/errors/errorCodes.ts\` — the \`ERROR_TAXONOMY\` record
   is the single source of truth. Choosing \`scope: "public"\` makes it part of
   the stable API contract; \`scope: "internal"\` keeps it out of the public
   surface.
2. For a new i18n key, add localized messages in
   \`src/i18n/locales.en.ts\` and \`src/i18n/locales.es.ts\`.
3. Add an \`AppError\` subclass in \`src/errors/AppError.ts\` if a new HTTP
   semantic is involved so middleware/route code can throw it directly.
4. Run \`npm run generate:error-docs\` to regenerate this document.
5. Add a test asserting the code propagates through the global handler.

## Client integration

- Match on \`code\`, never on \`error\`. The human-readable string is allowed to
  change between releases for clarity; codes are part of the API contract.
- \`code\` is stable; once published, removing or repurposing one is a
  breaking change.
- Treat \`5xx\` codes as retryable; treat \`4xx\` (except \`429\`) as terminal
  unless the caller can correct the input. \`429\` and \`503\` should be
  retried with backoff.
- \`requestId\` (when present) is the correlation key for support / log
  lookups.
`;

/** Scaffold a GitHub-style markdown table header for a scope column. */
function scopeBadge(scope: "public" | "internal"): string {
  return scope === "public" ? "public" : "internal";
}

/**
 * Builds the full markdown for docs/error-codes.md from ERROR_TAXONOMY.
 * Pure and deterministic so it is easy to unit-test.
 */
export function buildErrorCodesDoc(): string {
  const lines: string[] = [HEADER.trim(), ""];

  for (const category of Object.keys(CATEGORY_LABELS) as ErrorType["category"][]) {
    const label = CATEGORY_LABELS[category];
    const codes = CODE_ORDER.filter((code) => ERROR_TAXONOMY[code]?.category === category);

    lines.push(`### ${label.title}`);
    lines.push("");
    lines.push(
      "| Code                       | Status | Scope    | When emitted                                              |",
    );
    lines.push(
      "| -------------------------- | ------ | -------- | --------------------------------------------------------- |",
    );
    for (const code of codes) {
      const entry = ERROR_TAXONOMY[code];
      lines.push(
        `| \`${code.padEnd(26)}\` | ${String(entry.status).padEnd(4)}  | ${scopeBadge(entry.scope).padEnd(7)} | ${CODE_DESCRIPTIONS[code]} |`,
      );
    }
    lines.push("");
  }

  lines.push(FOOTER.trim());
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Writes the generated documentation to disk.
 * @param outputFile - Absolute or repo-relative path (defaults to docs/error-codes.md).
 * @param cwd - Working directory used to resolve relative output paths.
 */
export function writeErrorCodesDoc(
  outputFile: string = DEFAULT_OUTPUT_FILE,
  cwd: string = process.cwd(),
): string {
  const target = resolve(cwd, outputFile);
  writeFileSync(target, buildErrorCodesDoc(), "utf8");
  return target;
}

if (isMainModule) {
  const target = writeErrorCodesDoc();
  console.log(`Wrote ${target}`);
}
