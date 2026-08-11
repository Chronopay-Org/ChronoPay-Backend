import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { BackupDrillScheduler } from '../scheduler';

describe('BackupDrillScheduler', () => {
  let scheduler: BackupDrillScheduler;

  beforeEach(() => {
    // Earliest PIT is 30 days ago
    const earliestPit = Date.now() - 30 * 24 * 60 * 60 * 1000;
    scheduler = new BackupDrillScheduler(earliestPit);
  });

  describe('setupScratchEnv', () => {
    it('should successfully provision a scratch environment', async () => {
      const result = await scheduler.setupScratchEnv();
      expect(result).toBe(true);
    });
  });

  describe('restoreToPit', () => {
    it('should succeed for a valid recent timestamp', async () => {
      const targetTimestamp = Date.now() - 10000;
      const result = await scheduler.restoreToPit(targetTimestamp);
      expect(result.status).toBe('SUCCESS');
      expect(result.rtoMs).toBeGreaterThan(0);
      expect(result.rpoMs).toBeGreaterThanOrEqual(0);
    });

    it('should throw an error if PIT is before earliest available backup', async () => {
      const targetTimestamp = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago
      await expect(scheduler.restoreToPit(targetTimestamp)).rejects.toThrow('Requested PIT is before the earliest available backup');
    });

    it('should throw an error on restore timeout', async () => {
      const targetTimestamp = Date.now() - 10000;
      await expect(scheduler.restoreToPit(targetTimestamp, { simulateTimeout: true })).rejects.toThrow('Restore operation timed out');
    });

    it('should throw an error on storage full', async () => {
      const targetTimestamp = Date.now() - 10000;
      await expect(scheduler.restoreToPit(targetTimestamp, { simulateStorageFull: true })).rejects.toThrow('Insufficient storage in scratch environment');
    });

    it('should return FAILED status if data corruption simulated', async () => {
      const targetTimestamp = Date.now() - 10000;
      const result = await scheduler.restoreToPit(targetTimestamp, { simulateFailure: true });
      expect(result.status).toBe('FAILED');
    });
  });

  describe('runQuarterlyDrill', () => {
    it('should run a complete drill and return report with p95 metrics', async () => {
      const report = await scheduler.runQuarterlyDrill();
      expect(report.successes).toBe(20);
      expect(report.failures).toBe(0);
      expect(report.rtoP95Ms).toBeGreaterThan(0);
      expect(report.rpoP95Ms).toBeGreaterThanOrEqual(0);
      expect(report.timestamp).toBeLessThanOrEqual(Date.now());
    });

    it('should fail if scratch env setup fails', async () => {
      jest.spyOn(scheduler, 'setupScratchEnv').mockResolvedValueOnce(false);
      await expect(scheduler.runQuarterlyDrill()).rejects.toThrow('Failed to setup scratch environment');
    });

    it('should handle intermittent errors during drill execution', async () => {
      // Mock restoreToPit to fail randomly
      let callCount = 0;
      jest.spyOn(scheduler, 'restoreToPit').mockImplementation(async () => {
        callCount++;
        if (callCount % 5 === 0) {
          throw new Error('Random simulated error');
        }
        return {
          status: 'SUCCESS',
          rtoMs: 100,
          rpoMs: 50,
          details: 'OK'
        };
      });

      const report = await scheduler.runQuarterlyDrill();
      expect(report.successes).toBe(16);
      expect(report.failures).toBe(4);
      expect(report.rtoP95Ms).toBe(100);
      expect(report.rpoP95Ms).toBe(50);
    });

    it('should calculate P95 correctly with edge case (no successes)', async () => {
      jest.spyOn(scheduler, 'restoreToPit').mockImplementation(async () => {
        throw new Error('All fail');
      });

      const report = await scheduler.runQuarterlyDrill();
      expect(report.successes).toBe(0);
      expect(report.failures).toBe(20);
      expect(report.rtoP95Ms).toBe(0);
      expect(report.rpoP95Ms).toBe(0);
    });
  });
});
