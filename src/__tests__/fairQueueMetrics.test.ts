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

  it("does not expose raw user ids as metric label values", async () => {
    await request(app).get("/test").set("Authorization", "Bearer user:secret-user-42xyz");

    const output = await getMetricsText();
    expect(output).not.toContain("secret-user-42xyz");
    // Fair-queue metrics must be labeled by principal type, not by user id.
    expect(output).toContain('fair_queue_burn_rate_total{principal_type="user"}');
  });

  it("labels fair-queue metrics by principal type for api keys", async () => {
    await request(app).get("/test").set("Authorization", "Bearer apikey:key-abc-123");

    const output = await getMetricsText();
    expect(output).not.toContain("key-abc-123");
    expect(output).toContain('fair_queue_burn_rate_total{principal_type="apiKey"}');
  });

  it("does not record meaningless zero wait time observations", async () => {
    await request(app).get("/test").set("Authorization", "Bearer user:tenant-wait");

    const output = await getMetricsText();
    // Wait time should only be observed when a real wait occurred.
    expect(output).not.toContain("fair_queue_wait_time_seconds_count");
  });

  it("budgets fair-queue labels by principal type and overflows correctly", async () => {
    // Budget is 128 for fair_queue_burn_rate_total. Send many unique users.
    const requests = [];
    for (let i = 1; i <= 150; i++) {
      requests.push(request(app).get("/test").set("Authorization", `Bearer user:tenant-${i}`));
    }
    await Promise.all(requests);

    const output = await getMetricsText();

    // All users collapse into a single principal-type label, so no user id appears and no overflow occurs.
    expect(output).toContain('fair_queue_burn_rate_total{principal_type="user"} 150');
    for (let i = 1; i <= 150; i++) {
      expect(output).not.toContain(`tenant-${i}`);
    }
    expect(output).not.toContain('tenant_id="__overflow__"');
  });
});
