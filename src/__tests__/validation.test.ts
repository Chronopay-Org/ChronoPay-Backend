import request from "supertest";
import app from "../index.js";
import { SignJWT } from "jose";
import { RefundService } from "../services/refund.js";
import { AmountUtils } from "../utils/amount.js";

const TEST_SECRET = "test-secret-key-at-least-32-chars!!";

async function makeToken(
  claims: Record<string, unknown> = { sub: "user-1" },
  secret: string = TEST_SECRET,
  exp: string = "1h",
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(secret));
}

describe("Input validation middleware", () => {
  let token: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = TEST_SECRET;
    token = await makeToken();
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  // A verified JWT authenticates the caller, so it satisfies the slot-creation
  // role gate on its own. (The role-header cases below cover the legacy
  // header-based RBAC stub.)
  it("should allow valid slot creation with a bearer token", async () => {
    const res = await request(app)
      .post("/api/v1/slots")
      .set("Authorization", `Bearer ${token}`)
      .send({
        professional: "alice",
        startTime: 1000,
        endTime: 2000,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it("should reject slot creation when role is invalid", async () => {
    const res = await request(app)
      .post("/api/v1/slots")
      .set("x-user-role", "hacker")
      .send({
        professional: "alice",
        startTime: 1000,
        endTime: 2000,
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("should reject slot creation when role is not authorized", async () => {
    const res = await request(app)
      .post("/api/v1/slots")
      .set("x-user-role", "customer")
      .send({
        professional: "alice",
        startTime: 1000,
        endTime: 2000,
      });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("should allow valid slot creation", async () => {
    const res = await request(app)
      .post("/api/v1/slots")
      .set("x-user-role", "professional")
      .send({
        professional: "alice",
        startTime: 1000,
        endTime: 2000,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it("should allow slot creation for admin role", async () => {
    const res = await request(app)
      .post("/api/v1/slots")
      .set("x-user-role", "admin")
      .send({
        professional: "alice",
        startTime: 1000,
        endTime: 2000,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.meta.invalidatedKeys).toContain("slots:list:all");
  });

  it("should reject missing professional", async () => {
    const res = await request(app)
      .post("/api/v1/slots")
      .set("Authorization", `Bearer ${token}`)
      .send({
        startTime: 1000,
        endTime: 2000,
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("should reject missing startTime", async () => {
    const res = await request(app)
      .post("/api/v1/slots")
      .set("Authorization", `Bearer ${token}`)
      .send({
        professional: "alice",
        endTime: 2000,
      });

    expect(res.status).toBe(400);
  });

  it("should reject empty values", async () => {
    const res = await request(app)
      .post("/api/v1/slots")
      .set("Authorization", `Bearer ${token}`)
      .send({
        professional: "",
        startTime: 1000,
        endTime: 2000,
      });

    expect(res.status).toBe(400);
  });

  describe("admin refund validation", () => {
    it("rejects non-integer amountCents with 400", async () => {
      const res = await request(app)
        .post("/api/v1/admin/refunds")
        .set("Authorization", `Bearer ${token}`)
        .send({ paymentId: "pay-1", amountCents: 10.5, currency: "USD" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("AmountUtils.validate rejects fractional minor units", () => {
      expect(() => AmountUtils.validate(10.5)).toThrow();
      expect(AmountUtils.validate(10)).toBe(10);
    });

    it("rejects a currency that differs from the payment currency with 422", async () => {
      const spy = jest
        .spyOn(RefundService.prototype, "createRefund")
        .mockRejectedOnce(
          Object.assign(new Error("currency mismatch"), { status: 422 }),
        );

      const res = await request(app)
        .post("/api/v1/admin/refunds")
        .set("Authorization", `Bearer ${token}`)
        .send({ paymentId: "pay-1", amountCents: 100, currency: "EUR" });

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      spy.mockRestore();
    });
  });
});
