/**
 * Mock for ioredis library
 * Used in tests to avoid Redis dependency
 */

export class Redis {
  constructor() {}
  async connect() {}
  async disconnect() {}
  async get() { return null; }
  async set() { return 'OK'; }
  async del() { return 1; }
  async incr() { return 1; }
  async expire() { return 1; }
  async flushall() { return 'OK'; }
  on(_event: string, _callback: (...args: any[]) => void) {
    // Mock event emitter interface
    return this;
  }
}

export default Redis;
