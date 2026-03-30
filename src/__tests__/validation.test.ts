import request from "supertest";
import app from "../index.js";

describe("Input validation middleware", () => {
  let token: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = TEST_SECRET;
    token = await makeToken();
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  it("should allow valid slot creation", async () => {
    const res = await request(app)
      .post("/api/v1/slots")
      .set("Authorization", `Bearer ${token}`)
      .send({
        professional: "alice",
        startTime: 1000,
        endTime: 2000,
      });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
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
});
