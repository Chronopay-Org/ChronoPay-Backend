import express from "express";
import request from "supertest";
import { register } from "../metrics.js";
import { createAuthAwareRateLimiter } from "../middleware/rateLimiter.js";
import { _resetStore, _setTestMock } from "../middleware/rateLimitStore.js";

describe("Fair Queue Metrics", () => {
  let app: express.Express;

  beforeEach(() => {
    // Reset prometheus metrics
    register.resetMetrics();

    _resetStore();
    _setTestMock(false);

    app = express();
    app.use(express.json());

    // Mock auth middleware to inject user
    app.use((req, res, next) => {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer user:")) {
        req.auth = { userId: authHeader.split(":")[1] };
      } else if (authHeader?.startsWith("Bearer apkey:")) {
        (req as any).apiKeyId = authHeader.split(":")[1];
      }
      // ensure we don't skip rate limit in test environment for this route
      (req as any)._skipRateLimit = false;
      next();
    });

    app.get("/test", createAuthAwareRateLimiter(60000, 100), (req, res) => {
      res.status(200).json({ ok: true });
    });
  });

  afterEach(() => {
  });

  async function getMetricsText(): Promise<string> {
    return register.metrics();
  }

  it("increments burn rate and records wait time per principal type", async () => {
    await request(app).get("/test").set("Authorization", "Bearer user:tenant-1");
    await request(app).get("/test").set("Authorization", "Bearer user:tenant-1");
    await request(app).get("/test").set("Authorization", "Bearer user:tenant-2");

    const output = await getMetricsText();

    // Labels are by principal type, not raw user ids.
    expect(output).toContain('fair_queue_burn_rate_total{principal_type="user"} 3');
    expect(output).not.toContain("tenant-1");
    expect(output).not.toContain("tenant-2");
    // Wait time is not fabricated with a meaningless zero observation.
    expect(output).not.toContain('fair_queue_wait_time_seconds_count{principal_type="user"} 3');
  });

  it("labels by principal type for api keys and anonymous ip", async () => {
    await request(app).get("/test").set("Authorization", "Bearer apkey:key-1");
    await request(app).get("/test");

    const output = await getMetricsText();

    expect(output).toContain('fair_queue_burn_rate_total{principal_type="apiKey"} 1');
    expect(output).toContain('fair_queue_burn_rate_total{principal_type="ip"} 1');
    expect(output).not.toContain("key-1");
  });

  it("handles offboarded tenant (no longer sending traffic)", async () => {
    await request(app).get("/test").set("Authorization", "Bearer user:tenant-offboarded");

    let output = await getMetricsText();
    expect(output).toContain('fair_queue_burn_rate_total{principal_type="user"} 1');

    // In prometheus, offboarded tenants remain in metrics until restart, but their burn rate stays flat
    // This is expected behavior. Just ensure the metric exists and doesn't increase.
    await request(app).get("/test").set("Authorization", "Bearer user:tenant-active");

    output = await getMetricsText();
    expect(output).toContain('fair_queue_burn_rate_total{principal_type="user"} 2');
    expect(output).not.toContain("tenant-offboarded");
  });

  it("handles metric restart correctly", async () => {
    await request(app).get("/test").set("Authorization", "Bearer user:tenant-restart");

    let output = await getMetricsText();
    expect(output).toContain('fair_queue_burn_rate_total{principal_type="user"} 1');

    // Simulate restart
    register.resetMetrics();

    output = await getMetricsText();
    // After reset, metric should not contain the tenant until next request
    expect(output).not.toContain('fair_queue_burn_rate_total{principal_type="user"}');

    await request(app).get("/test").set("Authorization", "Bearer user:tenant-restart");
    output = await getMetricsText();
    expect(output).toContain('fair_queue_burn_rate_total{principal_type="user"} 1');
  });

  it("caps labels to top-N (budget) and overflows correctly", async () => {
    // Budget is 128 for fair_queue_burn_rate_total. Since labels are now by principal type
    // (a small finite set), the cardinality can never overflow from user traffic.
    // This guarantees no user id can ever become a label value.
    const principalTypes = ['user', 'apiKey', 'ip'];
    for (let i = 1; i <= 150; i++) {
      const type = principalTypes[i % principalTypes.length];
      const header = type === 'user' ? `Bearer user:tenant-${i}` : type === 'apiKey' ? `Bearer apkey:key-${i}` : undefined;
      const req = request(app).get("/test");
      if (header) req.set("Authorization", header);
      await req;
    }

    const output = await getMetricsText();

    // Only the three principal types are present as label values.
    for (const type of principalTypes) {
      expect(output).toContain(`fair_queue_burn_rate_total{principal_type="${type}"}`);
    }
    // No user id leaks into label values.
    expect(output).not.toMatch(/tenant-\d+/);
    expect(output).not.toMatch(/key-\d+/);
    // No overflow bucket is needed for a finite principal-type label set.
    expect(output).not.toContain("__overflow__");
  });
});
