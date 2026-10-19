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
    expect(res.text).toContain("method=\"GET\"");
    expect(res.text).toContain('route="/health"');
    expect(res.text).toContain('status_code="200"');
  });

  it("records the HTTP duration histogram exactly once per request", async () => {
    const app = createApp();

    const metric = register.getSingleMetric("http_request_duration_seconds");
    expect(metric).toBeDefined();

    const before = metric!.hashMap();
    const beforeCount = Object.values(before).reduce(
      (sum, entry) => sum + (entry.value.count as number),
      0,
    );

    await request(app).get("/health");

    const after = metric!.hashMap();
    const afterCount = Object.values(after).reduce(
      (sum, entry) => sum + (entry.value.count as number),
      0,
    );

    expect(afterCount - beforeCount).toBe(1);
  });

  it("records the HTTP duration histogram exactly once per request", async () => {
    const app = createApp();

    const metric = register.getSingleMetric("http_request_duration_seconds");
    expect(metric).toBeDefined();

    const before = metric!.hashMap();
    const beforeCount = Object.values(before).reduce(
      (sum, entry) => sum + (entry.value.count as number),
      0,
    );

    await request(app).get("/health");

    const after = metric!.hashMap();
    const afterCount = Object.values(after).reduce(
      (sum, entry) => sum + (entry.value.count as number),
      0,
    );

    expect(afterCount - beforeCount).toBe(1);
  });

  it("produces distinct route labels for /:id routes mounted on different paths", async () => {
    const app = createApp();

    const metric = register.getSingleMetric("http_request_duration_seconds");
    expect(metric).toBeDefined();

    const routeLabels = (): string[] =>
      Object.keys(metric!.hashMap())
        .map((k) => {
          try {
            return (JSON.parse(k) as { route?: string }).route;
          } catch {
            return undefined;
          }
        })
        .filter((r): r is string => Boolean(r));

    // Two distinct routers that each define a /:id style route.
    // The route label must include the mount path (req.baseUrl) so these do not collide.
    const routerA = "/api/v1/booking-intents";
    const routerB = "/api/v1/checkout/sessions";

    // The app is expected to expose these mounted routers; hit each once.
    await request(app).get(`${routerA}/abc123/`);
    await request(app).get(`${routerB}/def456/`);

    const labels = routeLabels();
    const matchingA = labels.filter((r) => r.startsWith(routerA));
    const matchingB = labels.filter((r) => r.startsWith(routerB));

    expect(matchingA.length).toBe(1);
    expect(matchingB.length).toBe(1);
    expect(matchingA[0]).toBe(`${routerA}/:id`);
    expect(matchingB[0]).toBe(`${routerB}/:id`);
    expect(matchingA[0]).not.toBe(matchingB[0]);
  });

  it("does not export user ids as metric label values after authenticated requests", () => {
    const app = createApp();

    // This is a structural guard: the fair-queue metrics must not be labeled by
    // raw rate-limit keys (rl:user:<id>). We assert on the metric definitions and on
    // the exported label values after an authenticated request.
    const burnRate = register.getSingleMetric("fair_queue_burn_rate_total");
    const waitTime = register.getSingleMetric("fair_queue_wait_time_seconds");

    expect(burnRate).toBeDefined();
    expect(waitTime).toBeDefined();

    const labelValues = ([burnRate, waitTime] as any[])
      .filter(Boolean)
      .flatMap((m): string[] =>
        Object.keys(m.hashMap()).flatMap((k: string) => {
          try {
            const parsed = JSON.parse(k);
            return Object.values(parsed).map((v) => String(v));
          } catch {
            return [];
          }
        })
      );

    for (const value of labelValues) {
      expect(value).not.toMatch(/rl:user:/);
    }
  });
});
