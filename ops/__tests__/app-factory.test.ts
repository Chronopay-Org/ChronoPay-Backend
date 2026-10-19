import { describe, expect, it, afterEach } from '@jest/globals';
import request from 'supertest';

const { createApp } = await import('../../src/app.js');

describe('createApp — AppFactoryOptions failure handling', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('refuses to enable test routes in production', () => {
    process.env.NODE_ENV = 'production';

    expect(() => createApp({ enableTestRoutes: true })).toThrow(
      "Test routes cannot be enabled in production. enableTestRoutes is true but NODE_ENV is 'production'.",
    );
  });

  it('allows test routes outside production', () => {
    process.env.NODE_ENV = 'test';

    expect(() => createApp({ enableTestRoutes: true })).not.toThrow();
  });

  it('serves the intentional test fault on /__test__/explode when enabled', async () => {
    process.env.NODE_ENV = 'test';
    const app = createApp({ enableTestRoutes: true });

    const res = await request(app).get('/__test__/explode');
    expect(res.status).toBe(500);
  });

  it('does not mount /__test__/explode by default', async () => {
    process.env.NODE_ENV = 'test';
    const app = createApp();

    const res = await request(app).get('/__test__/explode');
    expect(res.status).toBe(404);
  });

  it('returns 502 for the simulated SMS failure path', async () => {
    process.env.NODE_ENV = 'test';
    const app = createApp({ enableTestRoutes: true });

    const res = await request(app)
      .post('/api/v1/notifications/sms')
      .send({ to: '+15550001111', message: 'FAIL' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ success: false, error: 'Simulated failure' });
  });

  it('returns 200 for the SMS success path', async () => {
    process.env.NODE_ENV = 'test';
    const app = createApp({ enableTestRoutes: true });

    const res = await request(app)
      .post('/api/v1/notifications/sms')
      .send({ to: '+15550001111', message: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, provider: 'in-memory' });
  });

  it('rejects invalid test auth tokens and accepts valid ones', async () => {
    process.env.NODE_ENV = 'test';
    const app = createApp({ enableTestRoutes: true });

    const invalid = await request(app)
      .post('/api/v1/test/auth')
      .send({ token: 'invalid-token' });
    expect(invalid.status).toBe(401);

    const valid = await request(app)
      .post('/api/v1/test/auth')
      .send({ token: 'valid-token-for-primary-secret' });
    expect(valid.status).toBe(200);
  });
});
