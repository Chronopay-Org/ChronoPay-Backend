/**
 * Shared helper for building public download URLs used in GDPR and audit
 * export flows.
 *
 * The origin is derived from the `APP_URL` environment variable only — never
 * from request headers (`req.protocol` / `req.get("host")`).  This eliminates
 * host-header injection: an attacker cannot forge a `Host` header to receive
 * a signed download link pointing at their own domain.
 *
 * In production `APP_URL` must be set; if it is missing the helper throws so
 * the request fails closed rather than leaking a token to an untrusted origin.
 * In non-production (test / development) a sensible default is used when
 * `APP_URL` is unset, keeping local workflows friction-free.
 */

/**
 * Validate that a string is a well-formed http(s) URL without credentials.
 */
function parseBaseUrl(raw: string): URL | null {
  if (!raw || !/^https?:\/\//i.test(raw) || /[\s\\]/u.test(raw)) {
    return null;
  }
  try {
    const url = new URL(raw);
    // Reject URLs with embedded credentials.
    if (url.username || url.password) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * Returns the configured public base URL (origin only, no trailing slash).
 *
 * Reads `APP_URL` from the process environment. In production the variable
 * must be present and valid; otherwise an error is thrown so the caller
 * returns 500 instead of issuing a link to an attacker-controlled host.
 */
export function buildExportBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const rawAppUrl = env.APP_URL;

  if (rawAppUrl !== undefined) {
    const parsed = parseBaseUrl(rawAppUrl);
    if (parsed) {
      // Origin only — strip any path/query/fragment so the download path
      // is always relative to the configured origin.
      return `${parsed.protocol}//${parsed.host}`;
    }
    // APP_URL was provided but invalid.
    if (env.NODE_ENV === "production") {
      throw new Error("APP_URL is set but is not a valid http(s) URL.");
    }
    // Non-production: fall through to default rather than crashing tests/dev.
  }

  // APP_URL not set.
  if (env.NODE_ENV === "production") {
    throw new Error("APP_URL must be configured in production for export download URLs.");
  }

  // Non-production default — keeps local dev and tests working without
  // requiring every test to set APP_URL.
  return "http://localhost:3001";
}
