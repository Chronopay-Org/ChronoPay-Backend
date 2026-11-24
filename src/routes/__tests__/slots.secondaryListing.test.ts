import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import router from "../slots.js";
import { __test__clearSlots } from "../../repositories/slotRepository.js";
import { slotService } from "../../services/slotService.js";

const OWNED_SLOT_ID = "slot-11111111-1111-4111-8111-111111111111";
const NO_CONSENT_SLOT_ID = "slot-33333333-3333-4333-8333-333333333333";
const SYNTHETIC_SLOT_ID = "slot-44444444-4444-4444-8444-444444444444";

function buildApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

function listingBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    priceFloorCents: 1000,
    expiresAt: Date.now() + 60_000,
    ...extra,
  };
}

describe("POST /:id/listings", () => {
  const app = buildApp();

  beforeEach(() => {
    __test__clearSlots();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("rejects a slot with no persisted owner instead of treating the caller as its owner", async () => {
    jest.spyOn(slotService, "findById").mockResolvedValue({
      id: SYNTHETIC_SLOT_ID,
      professional: "supplier-4",
      startTime: 1_700_000_000_000,
      endTime: 1_700_000_360_000,
    } as any);

    const response = await request(app)
      .post(`/${SYNTHETIC_SLOT_ID}/listings`)
      .set("x-chronopay-user-id", "random-customer")
      .set("x-chronopay-role", "customer")
      .send(listingBody());

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/no transferable owner/i);
  });

  it("rejects a customer who is not the persisted owner", async () => {
    const response = await request(app)
      .post(`/${OWNED_SLOT_ID}/listings`)
      .set("x-chronopay-user-id", "buyer-b")
      .set("x-chronopay-role", "customer")
      .send(listingBody());

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/current slot owner/i);
  });

  it("allows the persisted owner when supplier consent is present on the slot", async () => {
    const response = await request(app)
      .post(`/${OWNED_SLOT_ID}/listings`)
      .set("x-chronopay-user-id", "buyer-1")
      .set("x-chronopay-role", "customer")
      .send(listingBody());

    expect(response.status).toBe(201);
    expect(response.body.listing.ownerId).toBe("buyer-1");
    expect(response.body.listing.supplierConsent).toBe(true);
  });

  it("does not accept caller-provided consent when the slot has no supplier consent", async () => {
    const response = await request(app)
      .post(`/${NO_CONSENT_SLOT_ID}/listings`)
      .set("x-chronopay-user-id", "buyer-3")
      .set("x-chronopay-role", "customer")
      .send(listingBody({ supplierConsent: true }));

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/supplierConsent must not be provided/i);
  });

  it("rejects listing when neither supplier-side consent flag is set", async () => {
    jest.spyOn(slotService, "findById").mockResolvedValue({
      id: SYNTHETIC_SLOT_ID,
      ownerId: "buyer-4",
      professional: "supplier-4",
      startTime: 1_700_000_000_000,
      endTime: 1_700_000_360_000,
    } as any);

    const response = await request(app)
      .post(`/${SYNTHETIC_SLOT_ID}/listings`)
      .set("x-chronopay-user-id", "buyer-4")
      .set("x-chronopay-role", "customer")
      .send(listingBody());

    expect(response.status).toBe(422);
    expect(response.body.error).toMatch(/supplier consent is required/i);
  });
});
