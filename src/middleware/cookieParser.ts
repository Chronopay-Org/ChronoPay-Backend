import type { RequestHandler } from "express";

/** Parse unsigned cookies without letting an unrelated malformed value fail HTTP. */
export const parseCookies: RequestHandler = (req, _res, next) => {
  const cookies: Record<string, string> = Object.create(null);
  req.cookies = cookies;

  for (const part of (req.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;

    const key = part.slice(0, separator).trim();
    if (!key || Object.hasOwn(cookies, key)) continue;

    let value = part.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }

    try {
      cookies[key] = decodeURIComponent(value);
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
      // Invalid escapes are expected untrusted input: retain the raw value.
      // Never log cookie contents, which may contain OAuth/session material.
      cookies[key] = value;
    }
  }

  next();
};
