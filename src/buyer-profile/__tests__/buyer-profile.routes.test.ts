import express from "express";
import request from "supertest";

jest.unstable_mockModule("../../middleware/auth.middleware.js", () => ({
  authenticate: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const id = req.header("x-test-user-id");
    if (!id) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    req.user = {
      id,
      sub: id,
      email: `${id}@example.com`,
      role: req.header("x-test-role") ?? "user",
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    return next();
  },
  authorize: (...allowedRoles: string[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (!req.user) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }
      if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({ success: false, error: "Insufficient permissions" });
      }
      return next();
    },
  UserRole: { USER: "user", ADMIN: "admin" },
}));

jest.unstable_mockModule("../../middleware/rateLimiter.js", () => ({
  createAuthAwareRateLimiter: () =>
    (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

const { default: buyerProfileRouter } = await import("../buyer-profile.routes.js");

const app = express();
app.use(express.json());
app.use("/api/v1/buyer-profiles", buyerProfileRouter);

const profileId = "00000000-0000-4000-8000-000000000001";

describe("buyer-profile routes", () => {
  const userId = `buyer-profile-routes-${Date.now()}`;
  const profile = {
    fullName: "  Ada   Lovelace ",
    email: `${userId}@example.com`.toUpperCase(),
    phoneNumber: "+1 (555) 123-4567",
    address: "  12 Analytical   Engine Way  ",
  };

  it("creates a profile, reads it, updates it, and soft-deletes it", async () => {
    const created = await request(app)
      .post("/api/v1/buyer-profiles")
      .set("x-test-user-id", userId)
      .send(profile)
      .expect(201);

    expect(created.body).toMatchObject({
      success: true,
      data: {
        userId,
        fullName: "Ada Lovelace",
        email: `${userId}@example.com`,
        phoneNumber: "+1 (555) 123-4567",
        address: "12 Analytical Engine Way",
      },
    });
    const id = created.body.data.id as string;

    await request(app)
      .get("/api/v1/buyer-profiles/me")
      .set("x-test-user-id", userId)
      .expect(200)
      .expect(({ body }) => expect(body.data.id).toBe(id));

    await request(app)
      .get(`/api/v1/buyer-profiles/${id}`)
      .set("x-test-user-id", userId)
      .expect(200)
      .expect(({ body }) => expect(body.data.email).toBe(`${userId}@example.com`));

    await request(app)
      .patch(`/api/v1/buyer-profiles/${id}`)
      .set("x-test-user-id", userId)
      .send({ fullName: "Ada Byron" })
      .expect(200)
      .expect(({ body }) => expect(body.data.fullName).toBe("Ada Byron"));

    await request(app)
      .delete(`/api/v1/buyer-profiles/${id}`)
      .set("x-test-user-id", userId)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ success: true }));

    await request(app)
      .get(`/api/v1/buyer-profiles/${id}`)
      .set("x-test-user-id", userId)
      .expect(404);
  });

  it("rejects invalid create data and invalid profile IDs before reaching handlers", async () => {
    const invalidCreate = await request(app)
      .post("/api/v1/buyer-profiles")
      .set("x-test-user-id", `${userId}-invalid`)
      .send({ ...profile, email: "not-an-email", unexpected: true })
      .expect(400);

    expect(invalidCreate.body).toMatchObject({ success: false, error: "Validation failed" });
    expect(invalidCreate.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "body", message: expect.stringContaining("Unknown field") }),
        expect.objectContaining({ field: "email", message: "Invalid email format" }),
      ]),
    );

    const invalidId = await request(app)
      .get("/api/v1/buyer-profiles/not-a-uuid")
      .set("x-test-user-id", userId)
      .expect(400);

    expect(invalidId.body.details).toContainEqual({ field: "id", message: "Invalid UUID format" });

    await request(app)
      .patch(`/api/v1/buyer-profiles/${profileId}`)
      .set("x-test-user-id", userId)
      .send({})
      .expect(400);
  });

  it("requires authentication and restricts profile listing to admins", async () => {
    await request(app).get("/api/v1/buyer-profiles/me").expect(401);
    await request(app)
      .get("/api/v1/buyer-profiles")
      .set("x-test-user-id", userId)
      .expect(403);

    const listing = await request(app)
      .get("/api/v1/buyer-profiles?page=1&limit=10")
      .set("x-test-user-id", `${userId}-admin`)
      .set("x-test-role", "admin")
      .expect(200);

    expect(listing.body).toMatchObject({
      success: true,
      pagination: { page: 1, limit: 10 },
    });
    expect(listing.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ userId })]));
  });

  it("rejects another user's access and reports missing profiles", async () => {
    await request(app)
      .get("/api/v1/buyer-profiles/00000000-0000-4000-8000-000000000099")
      .set("x-test-user-id", userId)
      .expect(404);

    const created = await request(app)
      .post("/api/v1/buyer-profiles")
      .set("x-test-user-id", `${userId}-owner-check`)
      .send({ ...profile, email: `${userId}-owner-check@example.com` })
      .expect(201);

    await request(app)
      .patch(`/api/v1/buyer-profiles/${created.body.data.id}`)
      .set("x-test-user-id", `${userId}-other`)
      .send({ fullName: "Unauthorized Change" })
      .expect(403);
  });
});