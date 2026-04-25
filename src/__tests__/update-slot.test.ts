import request from "supertest";
import app from "../index.js";
import { slotService } from "../services/slotService.js";

const ADMIN_TOKEN_ENV = "CHRONOPAY_ADMIN_TOKEN";

describe.skip("PATCH /api/v1/slots/:id", () => {
  const originalToken = process.env[ADMIN_TOKEN_ENV];

  beforeEach(() => {
    process.env[ADMIN_TOKEN_ENV] = "test-admin-token";
    slotService.reset();
  });

  afterAll(() => {
    if (originalToken === undefined) {
      delete process.env[ADMIN_TOKEN_ENV];
      return;
    }

    process.env[ADMIN_TOKEN_ENV] = originalToken;
  });

  async function createBaseSlot() {
    const response = await request(app).post("/api/v1/slots").send({
      professional: "alice",
      startTime: 1000,
      endTime: 2000,
    });

    expect(response.status).toBe(201);
    return response.body.slot.id as number;
  }

  it("updates an existing slot with a valid token", async () => {
    const slotId = await createBaseSlot();

    const response = await request(app)
      .patch(`/api/v1/slots/${slotId}`)
      .set("x-chronopay-admin-token", "test-admin-token")
      .send({
        professional: " bob ",
        endTime: 2200,
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.slot.professional).toBe("bob");
    expect(response.body.slot.startTime).toBe(1000);
    expect(response.body.slot.endTime).toBe(2200);
    expect(response.body.slot.updatedAt).not.toBe(response.body.slot.createdAt);
  });

  it("returns 401 when token header is missing", async () => {
    const slotId = await createBaseSlot();

    const response = await request(app).patch(`/api/v1/slots/${slotId}`).send({
      endTime: 2200,
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toContain("x-chronopay-admin-token");
  });

  it("returns 403 when token is invalid", async () => {
    const slotId = await createBaseSlot();

    const response = await request(app)
      .patch(`/api/v1/slots/${slotId}`)
      .set("x-chronopay-admin-token", "wrong-token")
      .send({ endTime: 2200 });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Invalid admin token");
  });

  it("returns 503 when server token is not configured", async () => {
    const slotId = await createBaseSlot();
    delete process.env[ADMIN_TOKEN_ENV];

    const response = await request(app)
      .patch(`/api/v1/slots/${slotId}`)
      .set("x-chronopay-admin-token", "test-admin-token")
      .send({ endTime: 2200 });

    process.env[ADMIN_TOKEN_ENV] = "test-admin-token";

    expect(response.status).toBe(503);
    expect(response.body.error).toBe("Update slot authorization is not configured");
  });

  it("returns 404 for unknown slot id", async () => {
    const response = await request(app)
      .patch("/api/v1/slots/999")
      .set("x-chronopay-admin-token", "test-admin-token")
      .send({ endTime: 2200 });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Slot 999 was not found");
  });

  it("returns 400 for invalid slot id", async () => {
    const response = await request(app)
      .patch("/api/v1/slots/not-a-number")
      .set("x-chronopay-admin-token", "test-admin-token")
      .send({ endTime: 2200 });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("slotId must be a positive integer");
  });

  it("returns 400 when payload has no updatable fields", async () => {
    const slotId = await createBaseSlot();

    const response = await request(app)
      .patch(`/api/v1/slots/${slotId}`)
      .set("x-chronopay-admin-token", "test-admin-token")
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("update payload must include at least one field");
  });

  it("returns 400 when update creates invalid time range", async () => {
    const slotId = await createBaseSlot();

    const response = await request(app)
      .patch(`/api/v1/slots/${slotId}`)
      .set("x-chronopay-admin-token", "test-admin-token")
      .send({ endTime: 900 });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("endTime must be greater than startTime");
  });

  it("returns 500 when update fails unexpectedly", async () => {
    const slotId = await createBaseSlot();
    const originalUpdateSlot = slotService.updateSlot;
    slotService.updateSlot = (() => {
      throw new Error("unexpected failure");
    }) as typeof slotService.updateSlot;

    const response = await request(app)
      .patch(`/api/v1/slots/${slotId}`)
      .set("x-chronopay-admin-token", "test-admin-token")
      .send({ endTime: 2100 });

    slotService.updateSlot = originalUpdateSlot;

    expect(response.status).toBe(500);
    expect(response.body.error).toBe("Slot update failed");
  });
});