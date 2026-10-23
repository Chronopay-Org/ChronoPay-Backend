import { describe, expect, it } from '@jest/globals';
import {
  FEATURE_FLAGS,
  getAllGuardedFeatureRoutes,
  isGuardedRouteRegistered,
} from '../registry.js';

describe('feature flag registry focused behavior', () => {
  it('exposes stable definitions and defaults', () => {
    expect(FEATURE_FLAGS.CREATE_SLOT).toMatchObject({
      envVar: 'FF_CREATE_SLOT',
      defaultEnabled: true,
    });
    expect(FEATURE_FLAGS.CREATE_BOOKING_INTENT.defaultEnabled).toBe(false);
    expect(Object.keys(FEATURE_FLAGS).length).toBeGreaterThan(0);
  });

  it('flattens guarded routes with their owning flag', () => {
    const routes = getAllGuardedFeatureRoutes();
    expect(routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ flag: 'CREATE_SLOT', method: 'POST', path: '/api/v1/slots' }),
    ]));
    expect(routes.every((route) => route.flag in FEATURE_FLAGS)).toBe(true);
  });

  it('normalizes method matching and rejects invalid route/flag combinations', () => {
    expect(isGuardedRouteRegistered('CREATE_SLOT', 'post', '/api/v1/slots')).toBe(true);
    expect(isGuardedRouteRegistered('CREATE_SLOT', 'GET', '/api/v1/slots')).toBe(false);
    expect(isGuardedRouteRegistered('CREATE_SLOT', 'POST', '/api/v1/unknown')).toBe(false);
    expect(() => isGuardedRouteRegistered('UNKNOWN' as never, 'GET', '/missing')).toThrow();
  });
});
