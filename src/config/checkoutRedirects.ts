/** Redirect policy is independent of authentication and never uses request hosts. */
function absoluteHttpUrl(value: string): URL | null {
  if (!/^https?:\/\//i.test(value) || /[\s\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return url.username || url.password ? null : url;
  } catch (error) {
    // Node's URL parser may throw from a different VM realm under ESM tests.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ERR_INVALID_URL"
    )
      return null;
    throw error;
  }
}

function allowedHosts(env: NodeJS.ProcessEnv): Set<string> {
  if (env.CHECKOUT_REDIRECT_ALLOWED_HOSTS === undefined) {
    const fallback = env.APP_URL && absoluteHttpUrl(env.APP_URL);
    return new Set(fallback ? [fallback.host] : []);
  }
  const hosts = new Set<string>();
  for (const entry of env.CHECKOUT_REDIRECT_ALLOWED_HOSTS.split(",")) {
    const host = entry.trim();
    // Entries are authorities (host[:port]), not URLs, credentials or patterns.
    if (!host || /[\s\\/@?#%*]/u.test(host)) return new Set();
    const parsed = absoluteHttpUrl(`https://${host}`);
    if (!parsed || parsed.pathname !== "/" || parsed.search || parsed.hash) return new Set();
    hosts.add(parsed.host);
  }
  return hosts;
}

export function isAllowedCheckoutRedirect(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  const url = absoluteHttpUrl(value);
  if (!url || (url.protocol !== "https:" && env.NODE_ENV === "production")) return false;
  return allowedHosts(env).has(url.host);
}
