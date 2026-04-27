import request from "supertest";
import app from "../index.js";

describe("Prometheus Metrics", () => {
  it("GET /metrics returns 200 and Prometheus formatted text", async () => {
    const res = await request(app).get("/metrics");
    
    expect(res.status).toBe(200);
    expect(res.header["content-type"]).toMatch(/^text\/plain/);
    
    // Check for some default metrics
    expect(res.text).toContain("process_cpu_user_seconds_total");
    expect(res.text).toContain("process_resident_memory_bytes");
    expect(res.text).toContain("nodejs_version_info");
  });

  it("GET /metrics includes custom HTTP request duration metrics after a request", async () => {
    // First, make a request to trigger metric collection
    await request(app).get("/health");
    
    // Then, check metrics
    const res = await request(app).get("/metrics");
    
    expect(res.status).toBe(200);
    expect(res.text).toContain("http_request_duration_seconds_bucket");
    expect(res.text).toContain('method="GET"');
    expect(res.text).toContain('route="/health"');
    expect(res.text).toContain('status_code="200"');
  });
});
