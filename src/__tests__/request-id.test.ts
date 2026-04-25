import request from "supertest";
import app from "../index.js";

describe("request correlation id", () => {
  it("returns provided x-request-id header unchanged", async () => {
    const requestId = "req_client_trace_12345678";
    const response = await request(app).get("/health").set("x-request-id", requestId);
    expect(response.status).toBe(200);
    expect(response.headers["x-request-id"]).toBe(requestId);
  });

  it("generates x-request-id when missing", async () => {
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(typeof response.headers["x-request-id"]).toBe("string");
    expect(response.headers["x-request-id"].length).toBeGreaterThan(8);
  });

  it("includes requestId in error response envelope", async () => {
    const requestId = "req_error_case_12345678";
    const response = await request(app)
      .get("/this-route-does-not-exist")
      .set("x-request-id", requestId);

    expect(response.status).toBe(404);
    expect(response.body?.error?.requestId).toBe(requestId);
  });
});
