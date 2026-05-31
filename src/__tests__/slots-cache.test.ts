import request from "supertest";
// @ts-expect-error - Auto-fixed by script
import app from "../app.js";
import { invalidateSlotsCache } from "../cache/slotCache.js";

describe("GET /api/v1/slots cache contract", () => {
  beforeEach(async () => {
    await invalidateSlotsCache();
  });

  it("should return X-Cache: MISS on the first request and X-Cache: HIT on the second", async () => {
    // First request - should be MISS
    const res1 = await request(app)
      .get("/api/v1/slots")
      .expect(200);

    expect(res1.header).toHaveProperty("x-cache", "MISS");
    expect(res1.body).toHaveProperty("slots");
    expect(Array.isArray(res1.body.slots)).toBe(true);

    // Second request - should be HIT
    const res2 = await request(app)
      .get("/api/v1/slots")
      .expect(200);

    expect(res2.header).toHaveProperty("x-cache", "HIT");
    expect(res2.body).toHaveProperty("slots");
    expect(Array.isArray(res2.body.slots)).toBe(true);
  });
});
