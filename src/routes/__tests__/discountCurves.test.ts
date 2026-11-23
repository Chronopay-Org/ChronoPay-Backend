import { jest } from "@jest/globals";
import request from "supertest";

jest.unstable_mockModule("../../middleware/rateLimiter.js", () => ({
  createAuthAwareRateLimiter:
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const [{ createApp }, { resetStore }] = await Promise.all([
  import("../../app.js"),
  import("../../services/discountCurveService.js"),
]);

const app = createApp({ enableDocs: false });

function asRole(userId: string, role = "supplier") {
  return {
    "x-chronopay-user-id": userId,
    "x-chronopay-role": role,
  };
}

function curve(id: string, supplierId = "supplier-a") {
  return {
    id,
    name: `Curve ${id}`,
    bundleId: "bundle-1",
    supplierId,
    tiers: [{ minQuantity: 1, discountRate: 0.1 }],
  };
}

describe("discount curves routes", () => {
  beforeEach(() => {
    resetStore();
  });

  it("mounts the routes and assigns created curves to the authenticated supplier", async () => {
    const response = await request(app)
      .post("/api/v1/discount-curves")
      .set(asRole("supplier-a"))
      .send(curve("curve-a", "supplier-b"));

    expect(response.status).toBe(201);
    expect(response.body.discountCurve.supplierId).toBe("supplier-a");
  });

  it("limits suppliers to their own curves in collection results", async () => {
    await request(app)
      .post("/api/v1/discount-curves")
      .set(asRole("supplier-a"))
      .send(curve("curve-a"));
    await request(app)
      .post("/api/v1/discount-curves")
      .set(asRole("supplier-b"))
      .send(curve("curve-b"));

    const response = await request(app)
      .get("/api/v1/discount-curves")
      .set(asRole("supplier-a"))
      .query({ supplierId: "supplier-b" });

    expect(response.status).toBe(200);
    expect(response.body.discountCurves.map((item: { id: string }) => item.id)).toEqual([
      "curve-a",
    ]);
  });

  it.each(["get", "patch", "delete"] as const)(
    "forbids a supplier from using %s on another supplier's curve",
    async (method) => {
      await request(app)
        .post("/api/v1/discount-curves")
        .set(asRole("supplier-a"))
        .send(curve("curve-a"));

      const action = request(app)[method]("/api/v1/discount-curves/curve-a")
        .set(asRole("supplier-b"));
      if (method === "patch") {
        action.send({ name: "Changed by another supplier" });
      }

      expect((await action).status).toBe(403);
    },
  );

  it("does not allow a supplier to transfer ownership with a patch", async () => {
    await request(app)
      .post("/api/v1/discount-curves")
      .set(asRole("supplier-a"))
      .send(curve("curve-a"));

    const response = await request(app)
      .patch("/api/v1/discount-curves/curve-a")
      .set(asRole("supplier-a"))
      .send({ supplierId: "supplier-b" });

    expect(response.status).toBe(200);
    expect(response.body.discountCurve.supplierId).toBe("supplier-a");
    expect(
      (
        await request(app)
          .get("/api/v1/discount-curves/curve-a")
          .set(asRole("supplier-b"))
      ).status,
    ).toBe(403);
  });

  it("allows admins to read, update, and delete another supplier's curve", async () => {
    await request(app)
      .post("/api/v1/discount-curves")
      .set(asRole("supplier-a"))
      .send(curve("curve-a"));

    const adminHeaders = asRole("admin-user", "admin");
    expect(
      (
        await request(app)
          .get("/api/v1/discount-curves/curve-a")
          .set(adminHeaders)
      ).status,
    ).toBe(200);

    const response = await request(app)
      .patch("/api/v1/discount-curves/curve-a")
      .set(adminHeaders)
      .send({ name: "Admin update" });

    expect(response.status).toBe(200);
    expect(response.body.discountCurve.name).toBe("Admin update");
    expect(response.body.discountCurve.supplierId).toBe("supplier-a");
    expect(
      (
        await request(app)
          .delete("/api/v1/discount-curves/curve-a")
          .set(adminHeaders)
      ).status,
    ).toBe(200);
  });
});
