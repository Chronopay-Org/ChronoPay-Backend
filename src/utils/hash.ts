import crypto from "crypto";

export const generateRequestHash = (method: string, url: string, body: any): string => {
  const hash = crypto.createHash("sha256");

  hash.update(method);
  hash.update(url);

  if (body) {
    // Stringify handles object determinism simplistically for MVP purposes
    hash.update(JSON.stringify(body));
  }

  return hash.digest("hex");
};
