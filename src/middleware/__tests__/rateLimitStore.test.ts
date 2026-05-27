import { jest } from '@jest/globals';

// 1. Define the mock data
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
  del: jest.fn<any, any>().mockImplementation(async (_key: string) => {
    storage.delete(_key);
    return 1;
  }),
  on: jest.fn<any, any>().mockReturnThis(),
  quit: jest.fn<any, any>().mockResolvedValue('OK'),
};

// 2. Mock the module
jest.unstable_mockModule('ioredis', () => {
  return {
    Redis: jest.fn<any, any>().mockImplementation(() => mockRedis),
    default: jest.fn<any, any>().mockImplementation(() => mockRedis),
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
});
