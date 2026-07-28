import { ChaosStore, ChaosResult } from '../store';

describe('ChaosStore', () => {
  let store: ChaosStore;

  beforeEach(() => {
    store = new ChaosStore();
  });

  const baseResult: ChaosResult = {
    experimentId: 'exp-1',
    timestamp: new Date('2023-01-15T12:00:00Z').getTime(),
    remediationTicketUrl: 'https://tickets.example.com/123',
    status: 'FAILED',
    details: 'Database timeout',
  };

  it('should save and get a result', () => {
    store.save(baseResult);
    const result = store.get('exp-1');
    expect(result).toEqual(baseResult);
  });

  it('should throw if experimentId is missing', () => {
    expect(() => {
      store.save({ ...baseResult, experimentId: '' });
    }).toThrow('Experiment ID is required');
  });

  it('should throw on duplicate experiment ID', () => {
    store.save(baseResult);
    expect(() => store.save({ ...baseResult, details: 'new details' })).toThrow('Duplicate experiment ID');
  });

  it('should return undefined for non-existent ID', () => {
    expect(store.get('non-existent')).toBeUndefined();
  });

  it('should return all results', () => {
    store.save(baseResult);
    store.save({ ...baseResult, experimentId: 'exp-2' });
    const results = store.getAll();
    expect(results.length).toBe(2);
  });

  describe('query', () => {
    beforeEach(() => {
      store.save(baseResult);
      store.save({
        experimentId: 'exp-2',
        timestamp: new Date('2023-02-20T12:00:00Z').getTime(),
        remediationTicketUrl: null,
        status: 'SUCCESS',
        details: 'Cache resilient',
      });
      store.save({
        experimentId: 'exp-3',
        timestamp: new Date('2023-03-25T12:00:00Z').getTime(),
        remediationTicketUrl: 'https://tickets.example.com/456',
        status: 'ERROR',
        details: 'Config error',
      });
    });

    it('should query by status', () => {
      const results = store.query({ status: 'SUCCESS' });
      expect(results.length).toBe(1);
      expect(results[0].experimentId).toBe('exp-2');
    });

    it('should query by since and until', () => {
      const since = new Date('2023-02-01T00:00:00Z').getTime();
      const until = new Date('2023-02-28T23:59:59Z').getTime();
      const results = store.query({ since, until });
      expect(results.length).toBe(1);
      expect(results[0].experimentId).toBe('exp-2');
    });

    it('should query by hasTicket', () => {
      const withTicket = store.query({ hasTicket: true });
      expect(withTicket.length).toBe(2);
      expect(withTicket.map(r => r.experimentId)).toContain('exp-1');
      expect(withTicket.map(r => r.experimentId)).toContain('exp-3');

      const withoutTicket = store.query({ hasTicket: false });
      expect(withoutTicket.length).toBe(1);
      expect(withoutTicket[0].experimentId).toBe('exp-2');
    });
  });

  describe('edge cases', () => {
    it('should handle ticket deleted (removeTicket)', () => {
      store.save(baseResult);
      expect(store.get('exp-1')?.remediationTicketUrl).not.toBeNull();
      store.removeTicket('exp-1');
      expect(store.get('exp-1')?.remediationTicketUrl).toBeNull();
    });

    it('should throw if removeTicket called on non-existent result', () => {
      expect(() => store.removeTicket('unknown')).toThrow('Not found');
    });

    it('should purge ancient results', () => {
      store.save(baseResult); // 2023-01-15
      store.save({
        ...baseResult,
        experimentId: 'exp-2',
        timestamp: new Date('2023-05-15T12:00:00Z').getTime(),
      }); // 2023-05-15

      const cutoff = new Date('2023-03-01T00:00:00Z').getTime();
      const purged = store.purgeAncient(cutoff);
      expect(purged).toBe(1);
      
      const remaining = store.getAll();
      expect(remaining.length).toBe(1);
      expect(remaining[0].experimentId).toBe('exp-2');
    });
  });

  describe('reporting integration', () => {
    it('should generate quarterly report', () => {
      store.save({
        ...baseResult,
        timestamp: new Date('2023-01-15T12:00:00Z').getTime(),
      });
      store.save({
        ...baseResult,
        experimentId: 'exp-2',
        status: 'SUCCESS',
        remediationTicketUrl: null,
        timestamp: new Date('2023-02-15T12:00:00Z').getTime(),
      });
      store.save({
        ...baseResult,
        experimentId: 'exp-3',
        status: 'FAILED',
        timestamp: new Date('2023-04-15T12:00:00Z').getTime(), // Q2
      });

      const report = store.generateQuarterlyReport(2023, 1);
      
      expect(report).toContain('## Chaos Results Report - Q1 2023');
      expect(report).toContain('Total Experiments: 2');
      expect(report).toContain('- Success: 1');
      expect(report).toContain('- Failed: 1');
      expect(report).toContain('- Error: 0');
      expect(report).toContain('exp-1');
      expect(report).toContain('exp-2');
      expect(report).not.toContain('exp-3');
    });
  });
});
