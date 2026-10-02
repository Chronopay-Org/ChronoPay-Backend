import { jest } from '@jest/globals';

// 1. Define the mock data
const storage = new Map<string, string>();
// Captures every `new Redis(url, options)` call so the connection/retry
// configuration can be asserted without a live server.
const redisConstructors: Array<{ url: string; options: any }> = [];
const mockRedis: any = {
  multi: jest.fn<any>().mockReturnThis(),
  incr: jest.fn<any>().mockImplementation(function(this: any, key: string) {
    const current = parseInt(storage.get(key) || '0', 10);
    storage.set(key, (current + 1).toString());
    return this; 
  }),
  expire: jest.fn<any>().mockReturnThis(),
  exec: jest.fn<any>().mockImplementation(async function(this: any) {
    const lastIncr = this.incr.mock.calls[this.incr.mock.calls.length - 1];
    const key = lastIncr[0];
    const val = parseInt(storage.get(key) || '1', 10);
    return [[null, val]];
  }),
  decr: jest.fn<any>().mockImplementation(async (key: string) => {
    const current = parseInt(storage.get(key) || '0', 10);
    storage.set(key, (current - 1).toString());
    return current - 1;
  }),
  del: jest.fn<any>().mockImplementation(async (_key: string) => {
    storage.delete(_key);
    return 1;
  }),
  on: jest.fn<any>().mockReturnThis(),
  quit: jest.fn<any>().mockResolvedValue('OK'),
};

// 2. Mock the module
jest.unstable_mockModule('ioredis', () => {
  const RedisMock = jest.fn<any>().mockImplementation((url: string, options: any) => {
    redisConstructors.push({ url, options });
    return mockRedis;
  });
  return {
    Redis: RedisMock,
    default: RedisMock,
  };
});

// 3. Import the module under test AFTER mocking
const { _createStore, _setTestMock, _resetStore } = await import('../rateLimitStore.js');

describe('rateLimitStore', () => {
  describe('Redis Store', () => {
    let store: any;

    beforeAll(() => {
      _setTestMock(true);
    });

    afterAll(() => {
      _setTestMock(false);
      _resetStore();
    });

    beforeEach(async () => {
      storage.clear();
      redisConstructors.length = 0;
      jest.clearAllMocks();
      _resetStore();
      store = _createStore('test'); 
    });

    it('should increment a key and return the new value', async () => {
      const key = 'test-key';
      const val1 = await store.incr(key);
      expect(val1).toBe(1);

      const val2 = await store.incr(key);
      expect(val2).toBe(2);
    });

    it('should decrease a key and return the new value', async () => {
      const key = 'test-key-decr';
      await store.incr(key); // 1
      await store.incr(key); // 2
      
      const val = await store.decrease(key);
      expect(val).toBe(1);
    });

    it('should reset a key', async () => {
      const key = 'test-key-reset';
      await store.incr(key);
      await store.resetKey(key);
      
      const val = await store.incr(key);
      expect(val).toBe(1);
    });

    it('should handle expiry in incr', async () => {
      const key = 'test-key-expiry';
      const expiryTime = Date.now() + 10000;
      const val = await store.incr(key, expiryTime);
      expect(val).toBe(1);
    });

    it('should close the client', async () => {
      await store.close();
      expect(mockRedis.quit).toHaveBeenCalled();
    });
  });

  describe('Noop Store (Test Mode)', () => {
    let store: any;

    beforeEach(() => {
      _setTestMock(false);
      _resetStore();
      store = _createStore('test');
    });

    it('should always return 1 for incr', async () => {
      const val1 = await store.incr('any');
      const val2 = await store.incr('any');
      expect(val1).toBe(1);
      expect(val2).toBe(1);
    });
  });

  describe('_setTestMock', () => {
    const originalEnv = process.env.NODE_ENV;

    beforeEach(() => {
      redisConstructors.length = 0;
      _resetStore();
    });

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalEnv;
      }
      _setTestMock(false);
      _resetStore();
    });

    it('keeps the no-op store when the mock flag is off', () => {
      _setTestMock(false);
      const store: any = _createStore('test');

      // No Redis client is constructed for the no-op store.
      expect(redisConstructors).toHaveLength(0);
      expect(store.increment).toBeDefined();
    });

    it('switches test mode to the Redis-backed store when the flag is on', () => {
      _setTestMock(true);
      _createStore('test');

      expect(redisConstructors).toHaveLength(1);
      expect(redisConstructors[0].url).toBe(process.env.REDIS_URL);
    });

    it('toggles back to the no-op store when the flag is turned off again', () => {
      _setTestMock(true);
      _createStore('test');
      expect(redisConstructors).toHaveLength(1);

      _setTestMock(false);
      redisConstructors.length = 0;
      _createStore('test');
      expect(redisConstructors).toHaveLength(0);
    });
  });

  describe('Redis retryStrategy failure handling', () => {
    const originalEnv = process.env.NODE_ENV;
    let retryStrategy: (times: number) => number | null;

    beforeEach(() => {
      redisConstructors.length = 0;
      _setTestMock(true);
      _resetStore();
      process.env.NODE_ENV = 'development';
      _createStore('development');
      retryStrategy = redisConstructors[0].options.retryStrategy;
    });

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalEnv;
      }
      _setTestMock(false);
      _resetStore();
    });

    it('constructs the client with lazyConnect enabled', () => {
      // Sanity check that we captured the options we are about to exercise.
      expect(redisConstructors[0].options.lazyConnect).toBe(true);
      expect(typeof retryStrategy).toBe('function');
    });

    it('backs off linearly for the first retry attempts', () => {
      expect(retryStrategy(1)).toBe(100);
      expect(retryStrategy(2)).toBe(200);
      expect(retryStrategy(5)).toBe(500);
      expect(retryStrategy(10)).toBe(1000);
    });

    it('gives up (returns null) after the 10th retry attempt', () => {
      expect(retryStrategy(11)).toBeNull();
      expect(retryStrategy(20)).toBeNull();
      expect(retryStrategy(1000)).toBeNull();
    });

    it('does not retry at all when NODE_ENV is test', () => {
      process.env.NODE_ENV = 'test';
      // The test-env guard is evaluated when the strategy runs, not when the
      // client is created, so the same captured strategy flips behaviour.
      expect(retryStrategy(1)).toBeNull();
      expect(retryStrategy(10)).toBeNull();
      expect(retryStrategy(11)).toBeNull();
    });

    it('restores normal backoff once NODE_ENV leaves test', () => {
      process.env.NODE_ENV = 'test';
      expect(retryStrategy(3)).toBeNull();

      process.env.NODE_ENV = 'production';
      expect(retryStrategy(3)).toBe(300);
    });
  });
});
