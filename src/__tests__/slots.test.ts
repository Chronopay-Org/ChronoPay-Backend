import request from "supertest";
import { jest } from "@jest/globals";
import app from "../index.js";
import * as slotRepository from "../repositories/slotRepository.js";
import { listSlots } from "../services/slotService.js";

describe.skip("GET /api/v1/slots pagination", () => {
  it("returns correct page and limit with data", async () => {
    const res = await request(app).get("/api/v1/slots?page=2&limit=5");
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
    expect(res.body.limit).toBe(5);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(5);
    expect(res.body.total).toBeGreaterThanOrEqual(5);
    expect(res.body.data[0]).not.toHaveProperty("_internalNote");
  });

  it("enforces default values when no query is provided", async () => {
    const res = await request(app).get("/api/v1/slots");
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(10);
  });

  it("returns empty array when page has no results", async () => {
    const res = await request(app).get("/api/v1/slots?page=999&limit=10");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(0);
  });

  it("rejects invalid page values", async () => {
    const res = await request(app).get("/api/v1/slots?page=0&limit=10");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid page");
  });

  it("rejects invalid limit values", async () => {
    const res = await request(app).get("/api/v1/slots?page=1&limit=0");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid limit");
  });

  it("rejects limit above max", async () => {
    const res = await request(app).get("/api/v1/slots?page=1&limit=101");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Limit exceeds maximum allowed value");
  });

  it("throws on repository failure", async () => {
    await expect(
      listSlots(
        { page: 1, limit: 10 },
        {
          getSlotsCount: async () => {
            throw new Error("Database is down");
          },
          getSlotsPage: async () => [],
        }
      )
    ).rejects.toThrow("Database is down");
  });
});
