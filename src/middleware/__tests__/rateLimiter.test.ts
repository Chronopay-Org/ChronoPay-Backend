import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';

const requestCounts = new Map<string, number>();
const rateLimitFactory = jest.fn((options: any) => {
  return (req: any, res: any, next: () => void) => {
    if (typeof options.skip === 'function' && options.skip(req)) {
      return next();
    }

    const key = typeof options.keyGenerator === 'function' ? options.keyGenerator(req) : 'default';
    const currentCount = requestCounts.get(key) ?? 0;
    const nextCount = currentCount + 1;
    requestCounts.set(key, nextCount);

    const limit = Number(options.limit ?? 0);
    const remaining = Math.max(limit - nextCount, 0);

    if (limit > 0 && nextCount > limit) {
      res.setHeader('ratelimit-limit', String(limit));
      res.setHeader('ratelimit-remaining', String(remaining));
      res.setHeader('ratelimit-reset', String(Math.ceil(Date.now() / 1000) + 60));
      return options.handler(req, res);
    }

    res.setHeader('ratelimit-limit', String(limit));
    res.setHeader('ratelimit-remaining', String(remaining));
    res.setHeader('ratelimit-reset', String(Math.ceil(Date.now() / 1000) + 60));
    return next();
  };
});

jest.unstable_mockModule('express-rate-limit', () => ({
  __esModule: true,
  default: rateLimitFactory,
}));

const {
  createAuthAwareRateLimiter,
  createRateLimiter,
  generateRateLimitKey,
} = await import('../rateLimiter.js');

describe('generateRateLimitKey', () => {
  it('prefers the authenticated user id over JWT, API key, and IP', () => {
    const req = {
      auth: { userId: 'user-123' },
      user: { sub: 'jwt-456', id: 'jwt-789' },
      apiKeyId: 'api-key-999',
      ip: '203.0.113.10',
    } as any;

    expect(generateRateLimitKey(req)).toBe('rl:user:user-123');
  });

  it('falls back to the JWT user id when auth is absent', () => {
    const req = {
      user: { sub: 'jwt-456' },
      apiKeyId: 'api-key-999',
      ip: '203.0.113.11',
    } as any;

    expect(generateRateLimitKey(req)).toBe('rl:user:jwt-456');
  });

  it('uses the API key as the next available identifier', () => {
    const req = {
      apiKeyId: 'api-key-777',
      ip: '203.0.113.12',
    } as any;

    expect(generateRateLimitKey(req)).toBe('rl:apiKey:api-key-777');
  });

  it('hashes the client IP for anonymous requests', () => {
    const req = { ip: '203.0.113.13' } as any;
    const expected = `rl:ip:${createHash('sha256').update('203.0.113.13', 'utf8').digest('hex')}`;

    expect(generateRateLimitKey(req)).toBe(expected);
  });

  it('handles missing or malformed values deterministically', () => {
    const anonymousHash = createHash('sha256').update('anonymous', 'utf8').digest('hex');

    expect(generateRateLimitKey({} as any)).toBe(`rl:ip:${anonymousHash}`);
    expect(generateRateLimitKey(undefined as any)).toBe(`rl:ip:${anonymousHash}`);
    expect(generateRateLimitKey({ user: { sub: '' }, apiKeyId: '', ip: null } as any)).toBe(`rl:ip:${anonymousHash}`);
  });
});

describe('createRateLimiter', () => {
  beforeEach(() => {
    requestCounts.clear();
    rateLimitFactory.mockClear();
  });

  it('enforces the configured limit and returns the standard 429 payload', async () => {
    const app = express();
    app.get('/limited', createRateLimiter(60_000, 2), (_req, res) => {
      res.status(200).json({ ok: true });
    });

    await request(app).get('/limited').expect(200);
    await request(app).get('/limited').expect(200);

    const response = await request(app).get('/limited').expect(429);
    expect(response.headers['ratelimit-limit']).toBe('2');
    expect(response.body).toMatchObject({
      success: false,
      error: 'Too many requests, please try again later.',
    });
  });
});

describe('createAuthAwareRateLimiter', () => {
  beforeEach(() => {
    requestCounts.clear();
    rateLimitFactory.mockClear();
  });

  it('builds auth-aware keys and skips bypassed requests', () => {
    const limiter = createAuthAwareRateLimiter(60_000, 2);
    const config = rateLimitFactory.mock.calls.at(-1)?.[0];

    expect(typeof limiter).toBe('function');
    expect(config.keyGenerator).toBeDefined();
    expect(config.store).toBeDefined();
    expect(config.skip({ internalBypassActor: 'internal' } as any)).toBe(true);
    expect(config.skip({ _skipRateLimit: false } as any)).toBe(false);
  });

  it('allows requests within the limit for a single tenant and blocks the next one', async () => {
    const app = express();
    app.use((req: any, _res, next) => {
      req._skipRateLimit = false;
      const userId = req.header('x-user-id');
      if (userId) req.auth = { userId };
      next();
    });

    app.get('/test', createAuthAwareRateLimiter(60_000, 2), (_req, res) => {
      res.status(200).json({ success: true });
    });

    await request(app).get('/test').expect(200);
    await request(app).get('/test').expect(200);
    const response = await request(app).get('/test').expect(429);

    expect(response.body).toMatchObject({
      success: false,
      error: 'Too many requests, please try again later.',
    });
  });

  it('separates the counter by authenticated principal and falls back to IP for anonymous users', async () => {
    const app = express();
    app.use((req: any, _res, next) => {
      req._skipRateLimit = false;
      const userId = req.header('x-user-id');
      if (userId) req.auth = { userId };
      next();
    });

    app.get('/test', createAuthAwareRateLimiter(60_000, 2), (_req, res) => {
      res.status(200).json({ success: true });
    });

    await request(app).get('/test').set('x-user-id', 'user-a').expect(200);
    await request(app).get('/test').set('x-user-id', 'user-a').expect(200);
    await request(app).get('/test').set('x-user-id', 'user-a').expect(429);

    await request(app).get('/test').set('x-user-id', 'user-b').expect(200);
    await request(app).get('/test').set('x-user-id', 'user-b').expect(200);

    await request(app).get('/test').expect(200);
    await request(app).get('/test').expect(200);
    await request(app).get('/test').expect(429);
  });
});
