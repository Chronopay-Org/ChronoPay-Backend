import { WINDOWS_MS, RouteMetrics, recordRouteTraffic, resetSloMetrics, SLO_OBJECTIVES } from '../sloMetrics.js';
import { RouteName, WindowName } from '../sloMetrics.js';

describe('sloMetrics', () => {
  beforeEach(() => {
    resetSloMetrics();
  });

  describe('WINDOWS_MS', () => {
    it('defines correct window times in milliseconds', () => {
      expect(WINDOWS_MS['5m']).toBe(5 * 60 * 1000);
      expect(WINDOWS_MS['1h']).toBe(60 * 60 * 1000);
      expect(WINDOWS_MS['6h']).toBe(6 * 60 * 60 * 1000);
    });
  });

  describe('RouteName and WindowName coverage', () => {
    it('supports all valid RouteNames with SLO objectives', () => {
      const validRoutes: RouteName[] = ['booking_intent', 'slots_list', 'checkout', 'escrow_listener'];
      validRoutes.forEach(route => {
        expect(SLO_OBJECTIVES).toHaveProperty(route);
        expect(typeof SLO_OBJECTIVES[route]).toBe('number');
        expect(SLO_OBJECTIVES[route]).toBeGreaterThan(0);
        expect(SLO_OBJECTIVES[route]).toBeLessThan(1);
      });
    });

    it('supports all valid WindowNames', () => {
      const validWindows: WindowName[] = ['5m', '1h', '6h'];
      validWindows.forEach(window => {
        expect(WINDOWS_MS).toHaveProperty(window);
      });
    });
  });

  describe('RouteMetrics state transitions', () => {
    let now: number;
    
    beforeEach(() => {
      now = 1000000000000; // Arbitrary fixed timestamp
    });

    it('initializes with empty buckets', () => {
      const metrics = new RouteMetrics('checkout');
      expect(metrics._getBuckets()).toEqual([]);
      expect(metrics.getBurnRate('5m', now)).toBe(0);
    });

    it('records successful traffic', () => {
      const metrics = new RouteMetrics('checkout');
      metrics.record(false, now);
      
      const buckets = metrics._getBuckets();
      expect(buckets.length).toBe(1);
      expect(buckets[0].total).toBe(1);
      expect(buckets[0].errors).toBe(0);
      expect(metrics.getBurnRate('5m', now)).toBe(0);
    });

    it('records error traffic and calculates burn rate deterministically', () => {
      const metrics = new RouteMetrics('checkout');
      
      // SLO for checkout is 99.99% (error budget 0.01% or 0.0001)
      // 1 error out of 1 total = 100% error rate (1.0)
      // burn rate = 1.0 / 0.0001 = 10000
      metrics.record(true, now);
      
      const buckets = metrics._getBuckets();
      expect(buckets.length).toBe(1);
      expect(buckets[0].total).toBe(1);
      expect(buckets[0].errors).toBe(1);
      
      const burnRate = metrics.getBurnRate('5m', now);
      expect(burnRate).toBeCloseTo(10000, 2);
    });

    it('groups multiple events in the same minute bucket', () => {
      const metrics = new RouteMetrics('slots_list');
      metrics.record(false, now);
      metrics.record(true, now + 10000); // +10s
      metrics.record(false, now + 30000); // +30s
      
      const buckets = metrics._getBuckets();
      expect(buckets.length).toBe(1); // Same 1-min bucket
      expect(buckets[0].total).toBe(3);
      expect(buckets[0].errors).toBe(1);
    });

    it('creates distinct buckets for events spanning different minutes', () => {
      const metrics = new RouteMetrics('booking_intent');
      metrics.record(false, now);
      metrics.record(false, now + 65000); // +65s
      
      const buckets = metrics._getBuckets();
      expect(buckets.length).toBe(2);
      expect(buckets[0].total).toBe(1);
      expect(buckets[1].total).toBe(1);
    });

    it('prunes buckets that fall outside the 6h boundary', () => {
      const metrics = new RouteMetrics('booking_intent');
      
      metrics.record(false, now - WINDOWS_MS['6h'] - 10000); // 6h and 10s ago
      
      const bucketsBefore = metrics._getBuckets();
      expect(bucketsBefore.length).toBe(1);
      
      // Trigger pruning with current time
      metrics.record(false, now);
      
      const bucketsAfter = metrics._getBuckets();
      expect(bucketsAfter.length).toBe(1);
      expect(bucketsAfter[0].timestamp).toBe(Math.floor(now / 60000) * 60000);
    });

    it('calculates burn rate accurately for different sliding windows', () => {
      const metrics = new RouteMetrics('booking_intent');
      
      // 10 minutes ago, 10 errors
      const tenMinsAgo = now - 10 * 60 * 1000;
      for (let i = 0; i < 10; i++) {
        metrics.record(true, tenMinsAgo); 
      }
      
      // 1 minute ago, 10 successes
      const oneMinAgo = now - 60 * 1000;
      for (let i = 0; i < 10; i++) {
        metrics.record(false, oneMinAgo); 
      }
      
      // 5m window: only sees 10 successes -> 0 errors -> burn rate 0
      expect(metrics.getBurnRate('5m', now)).toBe(0);
      
      // 1h window: sees 10 successes + 10 errors -> 50% errors
      // SLO 99.9% -> budget 0.001
      // burn rate = 0.5 / 0.001 = 500
      expect(metrics.getBurnRate('1h', now)).toBeCloseTo(500, 2);
    });
  });

  describe('recordRouteTraffic boundary and error behavior', () => {
    it('records traffic smoothly for a valid route without throwing', () => {
      expect(() => {
        recordRouteTraffic('booking_intent', true);
        recordRouteTraffic('booking_intent', false);
      }).not.toThrow();
    });

    it('safely ignores and does not crash on invalid/unrecognized route inputs', () => {
      expect(() => {
        recordRouteTraffic('invalid_route' as RouteName, false);
        recordRouteTraffic(undefined as any, true);
        recordRouteTraffic(null as any, false);
      }).not.toThrow();
    });
  });
});
