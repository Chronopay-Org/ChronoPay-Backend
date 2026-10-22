import { createHmac } from "node:crypto";

const TEST_JWT_SECRET = "chronopay-test-jwt-secret-at-least-32-characters";

export function createTestAuthorization(
  userId: string,
  role: string,
  expiresInSec = 3600,
): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    sub: userId,
    role,
    iat: now,
    exp: now + expiresInSec,
  })}`;
  const signature = createHmac("sha256", TEST_JWT_SECRET).update(unsigned).digest("base64url");
  return `Bearer ${unsigned}.${signature}`;
}
