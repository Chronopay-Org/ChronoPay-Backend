import { jest } from '@jest/globals';
import RedisMock from 'ioredis-mock';

const redisConstructors: Array<{ url: string; options: any }> = [];
const redisClients: any[] = [];

const RedisConstructor = jest.fn<any, any>().mockImplementation((url: string, options: any) => {
  redisConstructors.push({ url, options });
  const client = new RedisMock(url, options);
  redisClients.push(client);
  return client;
});

jest.unstable_mockModule('ioredis', () => ({
  Redis: RedisConstructor,
  default: RedisConstructor,
}));

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
      redisConstructors.length = 0;
      redisClients.length = 0;
      jest.clearAllMocks();
      _resetStore();
      store = _createStore('test');
      await store.init({ windowMs: 1_000 } as any);
      await redisClients.at(-1).flushall();
    });

    it('increments hit counts and reports the reset time', async () => {
      const first = await store.increment('test-key');
      const second = await store.increment('test-key');

      expect(first.totalHits).toBe(1);
      expect(first.resetTime).toBeInstanceOf(Date);
      expect(second.totalHits).toBe(2);
      expect(second.resetTime).toBeInstanceOf(Date);
    });

    it('decrements and resets a key', async () => {
      await store.increment('test-key');
      await store.increment('test-key');
      await store.decrement('test-key');

      expect((await store.increment('test-key')).totalHits).toBe(2);

      await store.resetKey('test-key');
      expect((await store.increment('test-key')).totalHits).toBe(1);
    });

    it('expires counters after the configured window', async () => {
      await store.init({ windowMs: 100 } as any);
      expect((await store.increment('expiring-key')).totalHits).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect((await store.increment('expiring-key')).totalHits).toBe(1);
    });

    it('closes the client', async () => {
      const quit = jest.spyOn(redisClients[0], 'quit');
      await store.close();
      expect(quit).toHaveBeenCalled();
    });
  });

  describe('Noop Store (Test Mode)', () => {
    let store: any;

    beforeEach(() => {
      _setTestMock(false);
      _resetStore();
      store = _createStore('test');
    });

    it('implements the store contract without retaining hit counts', async () => {
      const first = await store.increment('any');
      const second = await store.increment('any');

      expect(first.totalHits).toBe(1);
      expect(second.totalHits).toBe(1);
      expect(first.resetTime).toBeInstanceOf(Date);
      await expect(store.decrement('any')).resolves.toBeUndefined();
      await expect(store.resetKey('any')).resolves.toBeUndefined();
    });
  });

  describe('_setTestMock', () => {
    const originalEnv = process.env.NODE_ENV;

    beforeEach(() => {
      redisConstructors.length = 0;
      redisClients.length = 0;
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
      redisClients.length = 0;
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
      expect(redisConstructors[0].options.lazyConnect).toBe(true);
      expect(typeof retryStrategy).toBe('function');
    });

    it('backs off linearly for the first retry attempts', () => {
      expect(retryStrategy(1)).toBe(100);
      expect(retryStrategy(2)).toBe(200);
      expect(retryStrategy(5)).toBe(500);
      expect(retryStrategy(10)).toBe(1000);
    });

    it('gives up after the 10th retry attempt', () => {
      expect(retryStrategy(11)).toBeNull();
      expect(retryStrategy(20)).toBeNull();
      expect(retryStrategy(1000)).toBeNull();
    });

    it('does not retry when NODE_ENV is test', () => {
      process.env.NODE_ENV = 'test';
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
