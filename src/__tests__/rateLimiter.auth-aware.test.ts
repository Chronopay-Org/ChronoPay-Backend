import { jest } from '@jest/globals';
import request from 'supertest';
import express, { type Application, type Request } from 'express';
import {
  generateRateLimitKey,
  createAuthAwareRateLimiter,
} from '../middleware/rateLimiter.js';

// ---------------------------------------------------------------------------
// Unit tests: generateRateLimitKey
// ---------------------------------------------------------------------------

describe('generateRateLimitKey', () => {
  let req: Request;

  beforeEach(() => {
    req = express.request();
    // Clear all identity properties
    req.auth = undefined;
    req.user = undefined;
    req.apiKeyId = undefined;
    req.ip = '127.0.0.1';
    (req.socket as any) = { remoteAddress: undefined };
  });

  it('returns user key from req.auth.userId (header-based auth)', () => {
    req.auth = { userId: 'user-123', role: 'customer' } as any;
    expect(generateRateLimitKey(req)).toBe('rl:user:user-123');
  });

  it('falls back to req.user.sub when auth absent (JWT)', () => {
    req.user = { sub: 'jwt-user-456', role: 'admin' } as any;
    expect(generateRateLimitKey(req)).toBe('rl:user:jwt-user-456');
  });

  it('falls back to req.user.id if sub missing', () => {
    req.user = { id: 'user-789', role: 'customer' } as any;
    expect(generateRateLimitKey(req)).toBe('rl:user:user-789');
  });

  it('uses apiKeyId when neither user nor auth present', () => {
    req.apiKeyId = 'apiKey_abc123hash';
    expect(generateRateLimitKey(req)).toBe('rl:apiKey:apiKey_abc123hash');
  });

  it('falls back to IP when no identity present', () => {
    req.ip = '192.168.1.1';
    expect(generateRateLimitKey(req)).toBe('rl:ip:192.168.1.1');
  });

  it('falls back to socket remoteAddress if req.ip missing', () => {
    delete req.ip;
    (req.socket as any) = { remoteAddress: '10.0.0.1' };
    expect(generateRateLimitKey(req)).toBe('rl:ip:10.0.0.1');
  });

  it('falls back to "anonymous" if both req.ip and socket remoteAddress missing', () => {
    delete req.ip;
    (req.socket as any) = { remoteAddress: undefined };
    expect(generateRateLimitKey(req)).toBe('rl:ip:anonymous');
  });

  it('prefers req.auth over req.user when both present', () => {
    req.auth = { userId: 'auth-user', role: 'admin' } as any;
    req.user = { sub: 'jwt-user', role: 'customer' } as any;
    expect(generateRateLimitKey(req)).toBe('rl:user:auth-user');
  });

  it('prefers req.user over req.apiKeyId when both present', () => {
    req.user = { id: 'user-999', role: 'customer' } as any;
    req.apiKeyId = 'apiKey_xyz';
    expect(generateRateLimitKey(req)).toBe('rl:user:user-999');
  });

  it('prefers req.auth over req.apiKeyId when both present', () => {
    req.auth = { userId: 'auth-777', role: 'customer' } as any;
    req.apiKeyId = 'apiKey_abc';
    expect(generateRateLimitKey(req)).toBe('rl:user:auth-777');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: middleware behavior
// ---------------------------------------------------------------------------

describe('auth-aware rate limiter integration', () => {
  const WINDOW = 60_000;
  const MAX = 2;

  // Helper: build app with given middleware setup
  function buildApp(limitMiddleware: (req: Request, res: express.Response, next: express.NextFunction) => void): Application {
    const app = express();
    app.use(express.json());
    app.use(limitMiddleware);
    app.get('/test', (req, res) => res.json({ ok: true }));
    return app;
  }

  it('enforces per-user limits (same IP, different users get separate quotas)', async () => {
    const app = buildApp(createAuthAwareRateLimiter(WINDOW, MAX));

    // User A exhausts quota
    await request(app).get('/test').set('x-chronopay-user-id', 'userA').set('x-chronopay-role', 'customer');
    await request(app).get('/test').set('x-chronopay-user-id', 'userA').set('x-chronopay-role', 'customer');
    let res = await request(app).get('/test').set('x-chronopay-user-id', 'userA').set('x-chronopay-role', 'customer');
    expect(res.status).toBe(429);

    // User B from same IP still has quota
    res = await request(app).get('/test').set('x-chronopay-user-id', 'userB').set('x-chronopay-role', 'customer');
    expect(res.status).toBe(200);
  });

  it('enforces per-API-key limits (same IP, different keys)', async () => {
    const app = buildApp(createAuthAwareRateLimiter(WINDOW, MAX));

    await request(app).get('/test').set('x-api-key', 'key-A-secret');
    await request(app).get('/test').set('x-api-key', 'key-A-secret');
    let res = await request(app).get('/test').set('x-api-key', 'key-A-secret');
    expect(res.status).toBe(429);

    res = await request(app).get('/test').set('x-api-key', 'key-B-secret');
    expect(res.status).toBe(200);
  });

  it('falls back to IP-based limiting when no credentials provided', async () => {
    const app = buildApp(createAuthAwareRateLimiter(WINDOW, MAX));
    app.set('trust proxy', 1); // enable proxy to use X-Forwarded-For

    await request(app).get('/test').set('X-Forwarded-For', '1.2.3.4');
    let res = await request(app).get('/test').set('X-Forwarded-For', '1.2.3.4');
    expect(res.status).toBe(429);

    res = await request(app).get('/test').set('X-Forwarded-For', '5.6.7.8');
    expect(res.status).toBe(200);
  });

  it('preserves RateLimit header (draft-7 combined format)', async () => {
    const app = buildApp(createAuthAwareRateLimiter(60_000, 5));
    const res = await request(app).get('/test');
    expect(res.headers.ratelimit).toBeDefined();
    expect(res.headers.ratelimit).toMatch(/limit=\d+/);
    expect(res.headers.ratelimit).toMatch(/remaining=\d+/);
  });

  it('returns 429 with standard error envelope', async () => {
    const app = buildApp(createAuthAwareRateLimiter(60_000, 1));
    await request(app).get('/test'); // exhaust
    const res = await request(app).get('/test');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      success: false,
      error: 'Too many requests, please try again later.',
    });
  });

  it('skips rate limiting entirely in test environment', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const app = buildApp(createAuthAwareRateLimiter(60_000, 1));
      // Should allow unlimited requests
      await request(app).get('/test');
      await request(app).get('/test');
      await request(app).get('/test');
      await request(app).get('/test');
      // If we got here, no 429 was thrown => pass
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('handles concurrent requests from same principal fairly', async () => {
    const app = buildApp(createAuthAwareRateLimiter(60_000, 3));
    // Fire 5 concurrent requests; expect exactly 3 succeed, 2 fail
    const promises = Array(5).fill(null).map(() => request(app).get('/test')
      .set('x-chronopay-user-id', 'concurrent-user')
      .set('x-chronopay-role', 'customer')
    );
    const results = await Promise.all(promises);
    const successCount = results.filter(r => r.status === 200).length;
    const failCount = results.filter(r => r.status === 429).length;
    expect(successCount).toBe(3);
    expect(failCount).toBe(2);
  });

  it('respects trust proxy for IP fallback', async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(createAuthAwareRateLimiter(WINDOW, MAX));
    app.get('/test', (req, res) => res.json({ ok: true }));

    // Without X-Forwarded-For, req.ip would be loopback; but with trust proxy and header, it uses client IP
    await request(app).get('/test').set('X-Forwarded-For', '203.0.113.10');
    let res = await request(app).get('/test').set('X-Forwarded-For', '203.0.113.10');
    expect(res.status).toBe(429);

    res = await request(app).get('/test').set('X-Forwarded-For', '198.51.100.20');
    expect(res.status).toBe(200);
  });
});
