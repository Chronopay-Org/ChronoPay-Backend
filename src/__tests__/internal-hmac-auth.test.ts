import crypto from "node:crypto";
import request from "supertest";
import app from "../index.js";

const secret = "chronopay-internal-test-secret";

function sign(
  timestamp: string,
  method: string,
  path: string,
  body: Record<string, unknown>,
): string {
  const bodyHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex");
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${method}.${path}.${bodyHash}`)
    .digest("hex");
}

describe.skip("internal hmac endpoint auth", () => {
  const path = "/internal/cron/reminders/trigger";
  const body = { source: "cron" };

  beforeEach(() => {
    process.env.INTERNAL_HMAC_SECRET = secret;
  });

  afterEach(() => {
    delete process.env.INTERNAL_HMAC_SECRET;
  });

  it("accepts valid signed request", async () => {
    const timestamp = Date.now().toString();
    const signature = sign(timestamp, "POST", path, body);

    const res = await request(app)
      .post(path)
      .set("x-chronopay-timestamp", timestamp)
      .set("x-chronopay-signature", signature)
      .send(body);

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
  });

  it("rejects invalid signature", async () => {
    const res = await request(app)
      .post(path)
      .set("x-chronopay-timestamp", Date.now().toString())
      .set("x-chronopay-signature", "bad-signature")
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("rejects stale request timestamp", async () => {
    const staleTimestamp = (Date.now() - 15 * 60 * 1000).toString();
    const signature = sign(staleTimestamp, "POST", path, body);

    const res = await request(app)
      .post(path)
      .set("x-chronopay-timestamp", staleTimestamp)
      .set("x-chronopay-signature", signature)
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("rejects replayed request", async () => {
    const timestamp = Date.now().toString();
    const signature = sign(timestamp, "POST", path, body);

    const first = await request(app)
      .post(path)
      .set("x-chronopay-timestamp", timestamp)
      .set("x-chronopay-signature", signature)
      .send(body);
    const second = await request(app)
      .post(path)
      .set("x-chronopay-timestamp", timestamp)
      .set("x-chronopay-signature", signature)
      .send(body);

    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
  });
});
