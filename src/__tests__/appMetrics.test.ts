import request from "supertest";
import { createApp } from "../app.js";

describe("App factory Prometheus Metrics", () => {
  it("GET /metrics returns 200 and includes default and HTTP metrics", async () => {
    const app = createApp();

    // Trigger a request to populate HTTP metrics
    await request(app).get("/health");

    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.header["content-type"]).toMatch(/^text\/plain/);

    // Default process metrics
    expect(res.text).toContain("process_cpu_user_seconds_total");
    expect(res.text).toContain("process_resident_memory_bytes");

    // Custom HTTP request duration metric should be present after a request
    expect(res.text).toContain("http_request_duration_seconds_bucket");
    expect(res.text).toContain('method="GET"');
    expect(res.text).toContain('route="/health"');
    expect(res.text).toContain('status_code="200"');
  });
});
