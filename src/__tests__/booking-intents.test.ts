import request from "supertest";

import { createApp } from "../index.js";
import { BookingIntentService } from "../modules/booking-intents/booking-intent-service.js";
import { InMemoryBookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";

describe("Booking Intent API", () => {
  it("creates a booking intent for an authenticated customer", async () => {
    const app = createApp();

    const response = await request(app)
      .post("/api/v1/booking-intents")
      .set("x-chronopay-user-id", "customer-1")
      .send({
        slotId: "slot-100",
        note: "Please confirm wheelchair access",
        customerId: "spoofed-customer",
      });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.bookingIntent).toMatchObject({
      id: "intent-1",
      slotId: "slot-100",
      professional: "alice",
      customerId: "customer-1",
      status: "pending",
      note: "Please confirm wheelchair access",
    });
  });

  it("rejects unauthenticated and unauthorized callers", async () => {
    const app = createApp();

    const unauthenticated = await request(app)
      .post("/api/v1/booking-intents")
      .send({ slotId: "slot-100" });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toEqual({
      success: false,
      error: "Authentication required.",
    });

    const forbidden = await request(app)
      .post("/api/v1/booking-intents")
      .set("x-chronopay-user-id", "pro-1")
      .set("x-chronopay-role", "professional")
      .send({ slotId: "slot-100" });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toEqual({
      success: false,
      error: "Role is not authorized for this action.",
    });
  });

  it("rejects invalid payloads and edge-case note values", async () => {
    const app = createApp();

    const missingSlotId = await request(app)
      .post("/api/v1/booking-intents")
      .set("x-chronopay-user-id", "customer-1")
      .send({});
    expect(missingSlotId.status).toBe(400);
    expect(missingSlotId.body).toEqual({
      success: false,
      error: "slotId is required.",
    });

    const invalidSlotId = await request(app)
      .post("/api/v1/booking-intents")
      .set("x-chronopay-user-id", "customer-1")
      .send({ slotId: "slot!" });
    expect(invalidSlotId.status).toBe(400);

    const invalidNote = await request(app)
      .post("/api/v1/booking-intents")
      .set("x-chronopay-user-id", "customer-1")
      .send({ slotId: "slot-100", note: " " });
    expect(invalidNote.status).toBe(400);

    const oversizedNote = await request(app)
      .post("/api/v1/booking-intents")
      .set("x-chronopay-user-id", "customer-1")
      .send({ slotId: "slot-100", note: "x".repeat(501) });
    expect(oversizedNote.status).toBe(400);
  });

  it("returns explicit business-rule failures", async () => {
    const app = createApp();

    const missingSlot = await request(app)
      .post("/api/v1/booking-intents")
      .set("x-chronopay-user-id", "customer-1")
      .send({ slotId: "slot-missing" });
    expect(missingSlot.status).toBe(404);

    const unbookable = await request(app)
      .post("/api/v1/booking-intents")
      .set("x-chronopay-user-id", "customer-1")
      .send({ slotId: "slot-102" });
    expect(unbookable.status).toBe(409);
    expect(unbookable.body.error).toBe("Selected slot is not bookable.");

    const selfBooking = await request(app)
      .post("/api/v1/booking-intents")
      .set("x-chronopay-user-id", "alice")
      .send({ slotId: "slot-100" });
    expect(selfBooking.status).toBe(403);
    expect(selfBooking.body.error).toBe("You cannot create a booking intent for your own slot.");
  });

  it("prevents duplicate and conflicting booking intents", async () => {
    const app = createApp();

    const first = await request(app)
      .post("/api/v1/booking-intents")
      .set("x-chronopay-user-id", "customer-1")
      .send({ slotId: "slot-101" });
    expect(first.status).toBe(201);

    const duplicate = await request(app)
      .post("/api/v1/booking-intents")
      .set("x-chronopay-user-id", "customer-1")
      .send({ slotId: "slot-101" });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe("A booking intent already exists for this slot.");

    const conflict = await request(app)
      .post("/api/v1/booking-intents")
      .set("x-chronopay-user-id", "customer-2")
      .send({ slotId: "slot-101" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("Selected slot already has an active booking intent.");
  });

  it("sanitizes unexpected service failures", async () => {
    const failingService = {
      createIntent: () => {
        throw new Error("database blew up");
      },
    } as unknown as BookingIntentService;
    const app = createApp({
      slotRepository: new InMemorySlotRepository(),
      bookingIntentService: failingService,
    });

    const response = await request(app)
      .post("/api/v1/booking-intents")
      .set("x-chronopay-user-id", "customer-1")
      .send({ slotId: "slot-100" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      success: false,
      error: "Unable to create booking intent.",
    });
  });

  it("returns the in-memory slot catalog for booking discovery", async () => {
    const app = createApp();

    const response = await request(app).get("/api/v1/slots");

    expect(response.status).toBe(200);
    expect(response.body.slots).toHaveLength(3);
    expect(response.body.slots[0]).toMatchObject({
      id: "slot-100",
      professional: "alice",
      bookable: true,
    });
  });
});
