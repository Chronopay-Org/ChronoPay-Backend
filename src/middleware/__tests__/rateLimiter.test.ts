import { jest } from '@jest/globals';
import request from 'supertest';
import express, { Request, Response } from 'express';

// 1. Mock ioredis (used by rateLimitStore)
const storage = new Map<string, string>();
const mockRedis: any = {
  multi: jest.fn<any, any>().mockReturnThis(),
  incr: jest.fn<any, any>().mockImplementation(function(this: any, key: string) {
    const current = parseInt(storage.get(key) || '0', 10);
    storage.set(key, (current + 1).toString());
    return this; 
  }),
  expire: jest.fn<any, any>().mockReturnThis(),
  exec: jest.fn<any, any>().mockImplementation(async function(this: any) {
    const lastIncr = this.incr.mock.calls[this.incr.mock.calls.length - 1];
    const key = lastIncr[0];
    const val = parseInt(storage.get(key) || '1', 10);
    return [[null, val]];
  }),
  decr: jest.fn<any, any>().mockImplementation(async (key: string) => {
    const current = parseInt(storage.get(key) || '0', 10);
    storage.set(key, (current - 1).toString());
    return current - 1;
  }),
  del: jest.fn<any, any>().mockImplementation(async (key: string) => {
    storage.delete(key);
    return 1;
  }),
  on: jest.fn<any, any>().mockReturnThis(),
  quit: jest.fn<any, any>().mockResolvedValue('OK'),
};

jest.unstable_mockModule('ioredis', () => {
  return {
    Redis: jest.fn<any, any>().mockImplementation(() => mockRedis),
    default: jest.fn<any, any>().mockImplementation(() => mockRedis),
  };
});

// 2. Import modules AFTER mocking
const { createAuthAwareRateLimiter } = await import('../rateLimiter.js');
const { _setTestMock, _resetStore } = await import('../rateLimitStore.js');

describe('createAuthAwareRateLimiter', () => {
  let app: express.Express;
  const WINDOW_MS = 60000;
  const LIMIT = 2;

  beforeAll(() => {
    _setTestMock(true);
  });

  afterAll(() => {
    _setTestMock(false);
    _resetStore();
  });

  beforeEach(() => {
    storage.clear();
    jest.clearAllMocks();
    _resetStore();

    app = express();
    app.use(express.json());

    // Mock auth middleware to simulate different actors
    app.use((req: any, _res: any, next: any) => {
      req._skipRateLimit = false; // Force rate limiting in tests
      const userId = req.header('x-user-id');
      if (userId) {
        req.auth = { userId };
      }
      next();
    });

    const limiter = createAuthAwareRateLimiter(WINDOW_MS, LIMIT);
    
    app.get('/test', limiter, (_req: Request, res: Response) => {
      res.status(200).json({ success: true });
    });
  });

  it('should allow requests within the limit', async () => {
    await request(app).get('/test').expect(200);
    await request(app).get('/test').expect(200);
  });

  it('should return 429 when limit is exceeded', async () => {
    await request(app).get('/test').expect(200);
    await request(app).get('/test').expect(200);
    
    const response = await request(app).get('/test').expect(429);
    expect(response.body).toMatchObject({
      success: false,
      error: 'Too many requests, please try again later.'
    });
  });

  it('should include draft-7 standard headers', async () => {
    const response = await request(app).get('/test');
    expect(response.headers).toHaveProperty('ratelimit-limit');
    expect(response.headers).toHaveProperty('ratelimit-remaining');
    expect(response.headers).toHaveProperty('ratelimit-reset');
  });

  it('should have separate buckets for different users', async () => {
    // User A hits limit
    await request(app).get('/test').set('x-user-id', 'user-a').expect(200);
    await request(app).get('/test').set('x-user-id', 'user-a').expect(200);
    await request(app).get('/test').set('x-user-id', 'user-a').expect(429);

    // User B is still fine
    await request(app).get('/test').set('x-user-id', 'user-b').expect(200);
    await request(app).get('/test').set('x-user-id', 'user-b').expect(200);
  });

  it('should fallback to IP-based limits for anonymous users', async () => {
    // Anonymous user (IP 1) hits limit
    await request(app).get('/test').expect(200);
    await request(app).get('/test').expect(200);
    await request(app).get('/test').expect(429);
  });
});
