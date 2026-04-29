import request from "supertest";
import { SignJWT } from "jose";
import app from "../index.js";

const TEST_SECRET = "test-secret-key-at-least-32-chars!!";

async function makeToken(): Promise<string> {
  return new SignJWT({ sub: "user-1" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(TEST_SECRET));
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

  it("should allow valid slot creation with role header", async () => {
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
      .set("x-user-role", "professional")
      .send({
        startTime: 1000,
        endTime: 2000,
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details).toHaveLength(1);
    expect(res.body.details[0].path).toBe("professional");
    expect(res.body.details[0].rule).toBe("required");
  });

  it("should reject missing startTime", async () => {
    const res = await request(app)
      .post("/api/v1/slots")
      .set("x-user-role", "professional")
      .send({
        professional: "alice",
        endTime: 2000,
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details).toHaveLength(1);
    expect(res.body.details[0].path).toBe("startTime");
  });

  it("should reject empty values", async () => {
    const res = await request(app)
      .post("/api/v1/slots")
      .set("x-user-role", "professional")
      .send({
        professional: "",
        startTime: 1000,
        endTime: 2000,
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details).toHaveLength(1);
    expect(res.body.details[0].path).toBe("professional");
  });
});


  it("should return errors in deterministic order when multiple fields are missing", async () => {
    const res = await request(app)
      .post("/api/v1/slots")
      .set("x-user-role", "professional")
      .send({
        // Missing all required fields
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details).toHaveLength(3);
    
    // Check ordering: endTime, professional, startTime (alphabetical)
    const paths = res.body.details.map((d: any) => d.path);
    expect(paths).toEqual(["endTime", "professional", "startTime"]);
  });

  it("should collect all validation errors, not just the first", async () => {
    const res = await request(app)
      .post("/api/v1/slots")
      .set("x-user-role", "professional")
      .send({
        // Only professional is present
        professional: "alice"
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details).toHaveLength(2);
    
    // Should have errors for both missing fields
    const missingFields = res.body.details.map((d: any) => d.path);
    expect(missingFields).toContain("endTime");
    expect(missingFields).toContain("startTime");
  });