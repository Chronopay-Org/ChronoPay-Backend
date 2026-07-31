import { describe, expect, it, beforeEach, afterEach } from "@jest/globals";
import express from "express";
import request from "supertest";
import adminRouter from "../admin.js";
import { setRedisClient, type RedisClient } from "../../cache/redisClient.js";
import {
  DEFAULT_SUPPLIER_DAILY_BOOKING_CAP,
  defaultSupplierBookingCapService,
} from "../../services/supplierCap.js";

class FakeRedisClient implements RedisClient {
  readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<unknown> {
    return this.store.delete(key) ? 1 : 0;
  }

  async incr(key: string): Promise<number> {
    const next = (parseInt(this.store.get(key) ?? "0", 10) || 0) + 1;
    this.store.set(key, String(next));
    return next;
  }

  async expire(): Promise<unknown> {
    return 1;
  }

  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace("*", "");
    return Array.from(this.store.keys()).filter((k) => k.startsWith(prefix));
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  async quit(): Promise<unknown> {
    return "OK";
  }
}

const app = express();
app.use(express.json());
app.use("/api/v1/admin", adminRouter);

const adminHeaders = { "x-chronopay-admin-token": "test-admin-token" };

describe("Admin Supplier Booking-Cap API", () => {
  beforeEach(() => {
    process.env.CHRONOPAY_ADMIN_TOKEN = "test-admin-token";
    setRedisClient(new FakeRedisClient());
    defaultSupplierBookingCapService.reset();
  });

  afterEach(() => {
    delete process.env.CHRONOPAY_ADMIN_TOKEN;
    setRedisClient(null);
    defaultSupplierBookingCapService.reset();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).put("/api/v1/admin/suppliers/sup-1/booking-cap").send({ dailyCap: 50 });
    expect(res.status).toBe(401);
  });

  it("sets an override via PUT and reads it back via GET", async () => {
    const put = await request(app)
      .put("/api/v1/admin/suppliers/sup-1/booking-cap")
      .set(adminHeaders)
      .send({ dailyCap: 50, description: "trial promotion" });
    expect(put.status).toBe(200);
    expect(put.body.success).toBe(true);
    expect(put.body.override).toMatchObject({
      supplierId: "sup-1",
      dailyCap: 50,
      description: "trial promotion",
    });

    const get = await request(app).get("/api/v1/admin/suppliers/sup-1/booking-cap").set(adminHeaders);
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({
      success: true,
      supplierId: "sup-1",
      override: { supplierId: "sup-1", dailyCap: 50 },
      effectiveCap: 50,
      defaultCap: DEFAULT_SUPPLIER_DAILY_BOOKING_CAP,
    });
    expect(get.body.usage).toMatchObject({ supplierId: "sup-1", used: 0, cap: 50 });
  });

  it("reports the default cap for suppliers without an override", async () => {
    const get = await request(app).get("/api/v1/admin/suppliers/sup-2/booking-cap").set(adminHeaders);
    expect(get.status).toBe(200);
    expect(get.body.override).toBeNull();
    expect(get.body.effectiveCap).toBe(DEFAULT_SUPPLIER_DAILY_BOOKING_CAP);
  });

  it("accepts cap 0 as a soft block", async () => {
    const put = await request(app)
      .put("/api/v1/admin/suppliers/sup-1/booking-cap")
      .set(adminHeaders)
      .send({ dailyCap: 0 });
    expect(put.status).toBe(200);
    expect(put.body.override.dailyCap).toBe(0);
  });

  it("rejects invalid cap values with 400", async () => {
    const res = await request(app)
      .put("/api/v1/admin/suppliers/sup-1/booking-cap")
      .set(adminHeaders)
      .send({ dailyCap: -5 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("deletes an override via DELETE and 404s when none exists", async () => {
    await request(app)
      .put("/api/v1/admin/suppliers/sup-1/booking-cap")
      .set(adminHeaders)
      .send({ dailyCap: 25 });

    const del = await request(app)
      .delete("/api/v1/admin/suppliers/sup-1/booking-cap")
      .set(adminHeaders);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);

    const second = await request(app)
      .delete("/api/v1/admin/suppliers/sup-1/booking-cap")
      .set(adminHeaders);
    expect(second.status).toBe(404);
  });
});
