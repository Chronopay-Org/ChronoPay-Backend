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
      } else if (authHeader?.startsWith("Bearer apikey:")) {
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

  it("increments burn rate and records wait time per tenant", async () => {
    await request(app).get("/test").set("Authorization", "Bearer user:tenant-1");
    await request(app).get("/test").set("Authorization", "Bearer user:tenant-1");
    await request(app).get("/test").set("Authorization", "Bearer user:tenant-2");

    const output = await getMetricsText();
    
    expect(output).toContain('fair_queue_burn_rate_total{tenant_id="rl:user:tenant-1"} 2');
    expect(output).toContain('fair_queue_burn_rate_total{tenant_id="rl:user:tenant-2"} 1');
    expect(output).toContain('fair_queue_wait_time_seconds_count{tenant_id="rl:user:tenant-1"} 2');
    expect(output).toContain('fair_queue_wait_time_seconds_sum{tenant_id="rl:user:tenant-1"} 0');
  });

  it("handles offboarded tenant (no longer sending traffic)", async () => {
    await request(app).get("/test").set("Authorization", "Bearer user:tenant-offboarded");
    
    let output = await getMetricsText();
    expect(output).toContain('fair_queue_burn_rate_total{tenant_id="rl:user:tenant-offboarded"} 1');

    // In prometheus, offboarded tenants remain in metrics until restart, but their burn rate stays flat
    // This is expected behavior. Just ensure the metric exists and doesn't increase.
    await request(app).get("/test").set("Authorization", "Bearer user:tenant-active");
    
    output = await getMetricsText();
    expect(output).toContain('fair_queue_burn_rate_total{tenant_id="rl:user:tenant-offboarded"} 1');
    expect(output).toContain('fair_queue_burn_rate_total{tenant_id="rl:user:tenant-active"} 1');
  });

  it("handles metric restart correctly", async () => {
    await request(app).get("/test").set("Authorization", "Bearer user:tenant-restart");
    
    let output = await getMetricsText();
    expect(output).toContain('fair_queue_burn_rate_total{tenant_id="rl:user:tenant-restart"} 1');

    // Simulate restart
    register.resetMetrics();
    
    output = await getMetricsText();
    // After reset, metric should not contain the tenant until next request
    expect(output).not.toContain('fair_queue_burn_rate_total{tenant_id="rl:user:tenant-restart"}');
    
    await request(app).get("/test").set("Authorization", "Bearer user:tenant-restart");
    output = await getMetricsText();
    expect(output).toContain('fair_queue_burn_rate_total{tenant_id="rl:user:tenant-restart"} 1');
  });

  it("caps labels to top-N (budget) and overflows correctly", async () => {
    // Budget is 128 for fair_queue_burn_rate_total
    // We send 150 unique tenants concurrently to speed up the test
    const requests = [];
    for (let i = 1; i <= 150; i++) {
      requests.push(request(app).get("/test").set("Authorization", `Bearer user:tenant-${i}`));
    }
    await Promise.all(requests);

    const output = await getMetricsText();
    
    // First 125 should be tracked individually (budget is 128, minus 3 from other tests)
    expect(output).toContain('fair_queue_burn_rate_total{tenant_id="rl:user:tenant-1"} 1');
    expect(output).toContain('fair_queue_burn_rate_total{tenant_id="rl:user:tenant-100"} 1');
    expect(output).toContain('fair_queue_burn_rate_total{tenant_id="rl:user:tenant-125"} 1');
    
    // Remaining 25 should overflow (tenant-126 to tenant-150)
    expect(output).toContain('fair_queue_burn_rate_total{tenant_id="__overflow__"} 25');
    
    // Verify overflow metric is incremented
    expect(output).toContain('metric_cardinality_overflow_total{metric="fair_queue_burn_rate_total"} 25');
  });
});
