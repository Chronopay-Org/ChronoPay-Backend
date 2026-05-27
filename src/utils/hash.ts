import crypto from "crypto";

/**
 * Recursively sort object keys to ensure deterministic stringification.
 */
function stableStringify(obj: any): any {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(stableStringify);
  }
  const keys = Object.keys(obj).sort();
  const result: { [key: string]: any } = {};
  for (const key of keys) {
    result[key] = stableStringify(obj[key]);
  }
  return result;
}

export const generateRequestHash = (method: string, url: string, body: any): string => {
  const hash = crypto.createHash("sha256");

  hash.update(method);
  hash.update(url);

  if (body) {
    // Deterministic hashing ensures equivalent objects generate the same hash
    hash.update(JSON.stringify(stableStringify(body)));
  }

  return hash.digest("hex");
};
