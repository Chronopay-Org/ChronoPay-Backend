import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

const service = await import("../../services/discountCurveService.js");
const createDiscountCurveMock = jest.fn(service.createDiscountCurve);

jest.unstable_mockModule("../../middleware/auth.js", () => ({
  requireAuthenticatedActor:
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.unstable_mockModule("../../services/discountCurveService.js", () => ({
  ...service,
  createDiscountCurve: (input: unknown) => createDiscountCurveMock(input),
}));

const [{ router }, { genericErrorHandler }] = await Promise.all([
  import("../discountCurves.js"),
  import("../../middleware/errorHandling.js"),
]);

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const role = req.header("x-chronopay-role") === "admin" ? "admin" : "supplier";
  req.auth = {
    userId: req.header("x-chronopay-user-id") ?? "supplier-a",
    role,
  };
  next();
});
app.use("/api/v1/discount-curves", router);
app.use(genericErrorHandler);

function asRole(userId: string, role = "supplier") {
  return {
    "x-chronopay-user-id": userId,
    "x-chronopay-role": role,
  };
}

function curve(
  id: string,
  supplierId = "supplier-a",
  bundleId = "bundle-1",
  active = true,
) {
  return {
    id,
    name: `Curve ${id}`,
    bundleId,
    supplierId,
    active,
    tiers: [{ minQuantity: 1, discountRate: 0.1 }],
  };
}

describe("discount curves routes", () => {
  beforeEach(() => {
    service.resetStore();
    createDiscountCurveMock.mockClear();
  });

  it("creates a curve for the authenticated supplier", async () => {
    const response = await request(app)
      .post("/api/v1/discount-curves")
      .set(asRole("supplier-a"))
      .send(curve("curve-a", "supplier-b"));

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      success: true,
      discountCurve: { id: "curve-a", supplierId: "supplier-a" },
    });
  });

  it("maps unsorted tiers to a validation response", async () => {
    const response = await request(app)
      .post("/api/v1/discount-curves")
      .set(asRole("supplier-a"))
      .send({
        ...curve("curve-unsorted"),
        tiers: [
          { minQuantity: 2, discountRate: 0.2 },
          { minQuantity: 1, discountRate: 0.1 },
        ],
      });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      success: false,
      error: "Tiers must be sorted by minQuantity in ascending order",
    });
  });

  it("returns 422 for invalid stackability data", async () => {
    const response = await request(app)
      .post("/api/v1/discount-curves")
      .set(asRole("supplier-a"))
      .send({
        ...curve("curve-invalid-stackability"),
        stackability: { stackable: true, maxStackCount: 0 },
      });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      success: false,
      error: "stackability is invalid",
    });
  });

  it("applies supplierId, bundleId, and active=false filters and reports total", async () => {
    await request(app)
      .post("/api/v1/discount-curves")
      .set(asRole("supplier-a"))
      .send(curve("curve-match", "supplier-a", "bundle-1", false));
    await request(app)
      .post("/api/v1/discount-curves")
      .set(asRole("supplier-b"))
      .send(curve("curve-other-supplier", "supplier-b", "bundle-1", false));
    await request(app)
      .post("/api/v1/discount-curves")
      .set(asRole("supplier-a"))
      .send(curve("curve-other-bundle", "supplier-a", "bundle-2", false));
    await request(app)
      .post("/api/v1/discount-curves")
      .set(asRole("supplier-a"))
      .send(curve("curve-active", "supplier-a", "bundle-1", true));

    const response = await request(app)
      .get("/api/v1/discount-curves")
      .set(asRole("admin-user", "admin"))
      .query({
        supplierId: "supplier-a",
        bundleId: "bundle-1",
        active: "false",
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      total: 1,
      discountCurves: [{ id: "curve-match" }],
    });
  });

  it("returns 404 when getting an unknown curve", async () => {
    const response = await request(app)
      .get("/api/v1/discount-curves/missing")
      .set(asRole("supplier-a"));

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      error: "Discount curve not found: missing",
    });
  });

  it("gets and patches an existing curve", async () => {
    await request(app)
      .post("/api/v1/discount-curves")
      .set(asRole("supplier-a"))
      .send(curve("curve-a"));

    const getResponse = await request(app)
      .get("/api/v1/discount-curves/curve-a")
      .set(asRole("supplier-a"));
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.discountCurve.id).toBe("curve-a");

    const patchResponse = await request(app)
      .patch("/api/v1/discount-curves/curve-a")
      .set(asRole("supplier-a"))
      .send({ name: "Updated curve" });
    expect(patchResponse.status).toBe(200);
    expect(patchResponse.body.discountCurve.name).toBe("Updated curve");
  });

  it("returns 404 when patching an unknown curve", async () => {
    const response = await request(app)
      .patch("/api/v1/discount-curves/missing")
      .set(asRole("supplier-a"))
      .send({ name: "Updated" });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Discount curve not found: missing");
  });

  it("returns 404 when deleting an unknown curve", async () => {
    const response = await request(app)
      .delete("/api/v1/discount-curves/missing")
      .set(asRole("supplier-a"));

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Discount curve not found: missing");
  });

  it("returns the delete response after deleting a curve", async () => {
    await request(app)
      .post("/api/v1/discount-curves")
      .set(asRole("supplier-a"))
      .send(curve("curve-to-delete"));

    const response = await request(app)
      .delete("/api/v1/discount-curves/curve-to-delete")
      .set(asRole("supplier-a"));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, deleted: true });
  });

  it("returns the generic 500 response for an unexpected service error", async () => {
    createDiscountCurveMock.mockImplementationOnce(() => {
      throw new Error("unexpected service failure");
    });

    const response = await request(app)
      .post("/api/v1/discount-curves")
      .set(asRole("supplier-a"))
      .send(curve("curve-error"));

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      success: false,
      code: "INTERNAL_ERROR",
      error: "Internal server error",
    });
    expect(response.body.error).not.toContain("unexpected service failure");
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
});
