import request from 'supertest';
import app from './src/index.ts';
import { setFeatureFlagsFromEnv } from './src/flags/index.ts';
import { setRedisClient, type RedisClient } from './src/cache/redisClient.ts';
import { defaultAuditLogger } from './src/services/auditLogger.ts';

class InMemoryRedisMock implements RedisClient {
  private store = new Map<string, string>();
  async get(key: string) { return this.store.get(key) ?? null; }
  async set(key: string, value: string, _ex: 'EX', _ttl: number, condition?: 'NX') {
    if (condition === 'NX' && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }
  async del(key: string) { this.store.delete(key); return 1; }
  async keys(_pattern: string) { return []; }
  async quit() { return 'OK'; }
}

(async () => {
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
  setFeatureFlagsFromEnv({ ...process.env, FF_CREATE_BOOKING_INTENT: 'true' } as NodeJS.ProcessEnv);
  (defaultAuditLogger as any).log = async () => {};
  setRedisClient(new InMemoryRedisMock());

  const res = await request(app)
    .post('/api/v1/booking-intents')
    .set('x-chronopay-user-id', 'customer-123')
    .set('x-chronopay-role', 'customer')
    .set('Idempotency-Key', 'booking-intent-key-debug')
    .send({ slotId: 'slot-100', note: 'window seat' });

  console.log('status', res.status);
  console.log('body', JSON.stringify(res.body, null, 2));
})();
