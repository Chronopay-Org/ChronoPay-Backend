import { describe, expect, it, afterEach } from '@jest/globals';
import request from 'supertest';

const { createApp } = await import('../../src/app.js');

describe('createApp — AppFactoryOptions failure handling', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_ENABLE_TEST_ROUTES = process.env.ENABLE_TEST_ROUTES;

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_ENABLE_TEST_ROUTES === undefined) {
      delete process.env.ENABLE_TEST_ROUTES;
    } else {
      process.env.ENABLE_TEST_ROUTES = ORIGINAL_ENABLE_TEST_ROUTES;
    }
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

  it('keeps test routes available when explicitly enabled in the test environment', async () => {
    process.env.NODE_ENV = 'test';
    const app = createApp({ enableTestRoutes: true });

    const explode = await request(app).get('/__test__/explode');
    expect(explode.status).toBe(500);

    const valid = await request(app)
      .post('/api/v1/test/auth')
      .send({ token: 'valid-token-for-primary-secret' });
    expect(valid.status).toBe(200);

    const invalid = await request(app)
      .post('/api/v1/test/auth')
      .send({ token: 'invalid-token' });
    expect(invalid.status).toBe(401);
  });

  it('does not mount /api/v1/test/auth by default', async () => {
    process.env.NODE_ENV = 'test';
    const app = createApp();

    const res = await request(app)
      .post('/api/v1/test/auth')
      .send({ token: 'valid-token-for-primary-secret' });
    expect(res.status).toBe(404);
  });

  it('does not mount /__test__/explode in staging without an explicit opt-in', async () => {
    process.env.NODE_ENV = 'staging';
    delete process.env.ENABLE_TEST_ROUTES;
    const app = createApp();

    const res = await request(app).get('/__test__/explode');
    expect(res.status).toBe(404);
  });

  it('rejects unauthenticated requests on POST /api/v1/notifications/sms', async () => {
    process.env.NODE_ENV = 'test';
    const app = createApp();

    const res = await request(app)
      .post('/api/v1/notifications/sms')
      .send({ to: '+15550001111', message: 'hello' });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, error: 'Authentication required.' });
  });

  it('sends SMS through the real notifications router once authenticated', async () => {
    process.env.NODE_ENV = 'test';
    const app = createApp();

    const res = await request(app)
      .post('/api/v1/notifications/sms')
      .set('x-chronopay-user-id', 'user-1')
      .set('x-chronopay-role', 'customer')
      .send({ to: '+15550001111', message: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, provider: 'in-memory' });
    expect(res.body.providerMessageId).toBeDefined();
  });
});
