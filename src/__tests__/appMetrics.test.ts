import request from "supertest";
import { createApp } from "../app.js";
import { register } from "../metrics.js";

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

  it("records the HTTP duration histogram exactly once per request", async () => {
    const app = createApp();

    const before = await register.getSingleMetricAsString("http_request_duration_seconds");
    const beforeCount = extractCount(before);

    await request(app).get("/health");
    // Wait for the finish listener to run.
    await new Promise((resolve) => setImmediate(resolve));

    const after = await register.getSingleMetricAsString("http_request_duration_seconds");
    const afterCount = extractCount(after);

    expect(afterCount - beforeCount).toBe(1);
  });
});

function extractCount(metricText: string | undefined): number {
  if (!metricText) return 0;
  const match = metricText.match(/_count\{[^}]*}\s([\d.]+)/m);
  if (!match) return 0;
  return Number(match[1]);
}
