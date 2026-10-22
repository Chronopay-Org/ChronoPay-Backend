import { describe, expect, it } from "@jest/globals";
import request from "supertest";
import { createApp } from "../app.js";

describe("cookies at the HTTP boundary", () => {
  it("keeps serving requests when another cookie contains malformed escapes", async () => {
    const app = createApp({ enableDocs: false });
    const response = await request(app)
      .get("/health")
      .set("x-strict-health", "1")
      .set("Cookie", "bad=%E0%A4%A; ok=1");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", service: "chronopay-backend" });
  });
});
