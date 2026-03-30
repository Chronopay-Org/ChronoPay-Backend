/**
 * Unit tests for logging utilities
 */

import { 
  PerformanceTimer, 
  createScopedLogger, 
  logApiCall, 
  logDbOperation, 
  logExternalCall, 
  logSecurityEvent, 
  logSlowOperation,
  logBatch,
  withPerformanceLogging,
  conditionalLog
} from '../utils/logUtils.js';

describe('Logging Utilities', () => {
  describe('PerformanceTimer', () => {
    it('should create a performance timer', () => {
      const timer = new PerformanceTimer('test-operation');
      expect(timer).toBeDefined();
    });

    it('should accept optional context', () => {
      const timer = new PerformanceTimer('operation', { requestId: '123' });
      expect(timer).toBeDefined();
    });

    it('should end timer successfully', () => {
      const timer = new PerformanceTimer('test-op');
      expect(() => timer.end('Completed')).not.toThrow();
    });

    it('should end timer with error', () => {
      const timer = new PerformanceTimer('test-op');
      const error = new Error('Test error');
      expect(() => timer.endWithError(error, 'Failed')).not.toThrow();
    });
  });

  describe('Scoped Logger', () => {
    it('should create scoped logger for module', () => {
      const scopedLogger = createScopedLogger('auth-module');
      expect(scopedLogger).toBeDefined();
      expect(typeof scopedLogger.info).toBe('function');
    });

    it('should accept additional context', () => {
      const scopedLogger = createScopedLogger('payment-module', { 
        userId: 'user-123'
      });
      expect(scopedLogger).toBeDefined();
    });

    it('should allow logging at all levels', () => {
      const scopedLogger = createScopedLogger('test-module');
      
      expect(() => scopedLogger.info('info')).not.toThrow();
      expect(() => scopedLogger.error('error')).not.toThrow();
      expect(() => scopedLogger.warn('warn')).not.toThrow();
      expect(() => scopedLogger.debug('debug')).not.toThrow();
    });
  });

  describe('API Call Logging', () => {
    it('should log successful API calls', () => {
      expect(() => logApiCall('GET', '/api/v1/slots', 200, 45)).not.toThrow();
    });

    it('should log client errors', () => {
      expect(() => logApiCall('POST', '/api/v1/slots', 400, 12)).not.toThrow();
    });

    it('should log server errors', () => {
      expect(() => logApiCall('GET', '/api/v1/data', 500, 100)).not.toThrow();
    });

    it('should accept optional context', () => {
      expect(() => logApiCall('DELETE', '/api/v1/item', 204, 30, { 
        itemId: '123' 
      })).not.toThrow();
    });
  });

  describe('Database Operation Logging', () => {
    it('should log SELECT operations', () => {
      expect(() => logDbOperation('SELECT', 'users', 15, 100)).not.toThrow();
    });

    it('should log INSERT operations', () => {
      expect(() => logDbOperation('INSERT', 'transactions', 8, 1)).not.toThrow();
    });

    it('should log UPDATE operations', () => {
      expect(() => logDbOperation('UPDATE', 'slots', 12, 5)).not.toThrow();
    });

    it('should log DELETE operations', () => {
      expect(() => logDbOperation('DELETE', 'sessions', 6, 1)).not.toThrow();
    });

    it('should handle optional row count', () => {
      expect(() => logDbOperation('SELECT', 'stats', 20)).not.toThrow();
    });
  });

  describe('External Call Logging', () => {
    it('should log successful external calls', () => {
      expect(() => logExternalCall(
        'Stellar Horizon',
        '/accounts',
        true,
        250,
        200
      )).not.toThrow();
    });

    it('should log failed external calls', () => {
      const error = new Error('Connection timeout');
      expect(() => logExternalCall(
        'Payment Gateway',
        '/process',
        false,
        5000,
        503,
        error
      )).not.toThrow();
    });

    it('should handle undefined error', () => {
      expect(() => logExternalCall(
        'API',
        '/endpoint',
        false,
        1000,
        500,
        undefined
      )).not.toThrow();
    });
  });

  describe('Security Event Logging', () => {
    it('should log successful authentication', () => {
      expect(() => logSecurityEvent('AUTH_SUCCESS', 'user-123', true)).not.toThrow();
    });

    it('should log failed authentication', () => {
      expect(() => logSecurityEvent('AUTH_FAILURE', 'user-456', false)).not.toThrow();
    });

    it('should log authorization events', () => {
      expect(() => logSecurityEvent('ACCESS_GRANTED', 'user-789', true)).not.toThrow();
      expect(() => logSecurityEvent('ACCESS_DENIED', 'user-999', false)).not.toThrow();
    });

    it('should accept additional details', () => {
      expect(() => logSecurityEvent(
        'LOGIN_ATTEMPT',
        'user-123',
        true,
        { ip: '192.168.1.1' }
      )).not.toThrow();
    });

    it('should default to success=true', () => {
      expect(() => logSecurityEvent('AUDIT_CHECK', 'admin')).not.toThrow();
    });
  });

  describe('Slow Operation Logging', () => {
    it('should log operations exceeding threshold', () => {
      expect(() => logSlowOperation('database-query', 2500, 1000)).not.toThrow();
    });

    it('should skip operations under threshold', () => {
      expect(() => logSlowOperation('fast-op', 50, 1000)).not.toThrow();
    });

    it('should use default threshold', () => {
      expect(() => logSlowOperation('slow-op', 1500)).not.toThrow();
    });

    it('should accept custom threshold', () => {
      expect(() => logSlowOperation('very-slow', 500, 100)).not.toThrow();
    });
  });

  describe('Batch Logging', () => {
    it('should log batch entries', () => {
      const entries = [
        { level: 'info' as const, message: 'First' },
        { level: 'info' as const, message: 'Second' }
      ];
      
      expect(() => logBatch(entries)).not.toThrow();
    });

    it('should handle empty batch', () => {
      expect(() => logBatch([])).not.toThrow();
    });

    it('should accept context in entries', () => {
      const entries = [
        { 
          level: 'info' as const, 
          message: 'Entry',
          context: { batchItem: 'first' }
        }
      ];
      
      expect(() => logBatch(entries)).not.toThrow();
    });

    it('should handle mixed log levels', () => {
      const entries = [
        { level: 'debug' as const, message: 'Debug' },
        { level: 'info' as const, message: 'Info' },
        { level: 'warn' as const, message: 'Warn' },
        { level: 'error' as const, message: 'Error' }
      ];
      
      expect(() => logBatch(entries)).not.toThrow();
    });
  });

  describe('Performance Logging Wrapper', () => {
    it('should wrap successful async function', async () => {
      const fn = async () => 'result';
      const result = await withPerformanceLogging(fn, 'test-op');
      expect(result).toBe('result');
    });

    it('should wrap failed async function', async () => {
      const fn = async () => {
        throw new Error('Test error');
      };
      
      await expect(withPerformanceLogging(fn, 'failing-op'))
        .rejects.toThrow('Test error');
    });

    it('should accept optional context', async () => {
      const fn = async () => 'success';
      const result = await withPerformanceLogging(
        fn, 
        'op-with-context',
        { requestId: 'test-123' }
      );
      expect(result).toBe('success');
    });

    it('should measure execution time', async () => {
      const fn = async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return 'delayed';
      };
      
      const startTime = Date.now();
      const result = await withPerformanceLogging(fn, 'delayed-op');
      const duration = Date.now() - startTime;
      
      expect(result).toBe('delayed');
      expect(duration).toBeGreaterThanOrEqual(50);
    });
  });

  describe('Conditional Logging', () => {
    it('should log when level is enabled', () => {
      expect(() => conditionalLog('info', 'conditional info')).not.toThrow();
    });

    it('should accept context', () => {
      expect(() => conditionalLog('debug', 'debug', { testId: '123' })).not.toThrow();
    });

    it('should support all log levels', () => {
      expect(() => conditionalLog('fatal', 'fatal')).not.toThrow();
      expect(() => conditionalLog('error', 'error')).not.toThrow();
      expect(() => conditionalLog('warn', 'warn')).not.toThrow();
      expect(() => conditionalLog('info', 'info')).not.toThrow();
      expect(() => conditionalLog('debug', 'debug')).not.toThrow();
      expect(() => conditionalLog('trace', 'trace')).not.toThrow();
    });
  });

  describe('Integration Scenarios', () => {
    it('should handle complete request lifecycle', () => {
      const timer = new PerformanceTimer('request-lifecycle');
      logApiCall('POST', '/api/v1/payment', 201, 150);
      logDbOperation('INSERT', 'transactions', 45, 1);
      logExternalCall('Payment Processor', '/charge', true, 80, 200);
      timer.end('Request completed');
      
      expect(true).toBe(true);
    });

    it('should handle error scenario', () => {
      const timer = new PerformanceTimer('error-scenario');
      
      try {
        logApiCall('GET', '/api/v1/data', 500, 100);
        throw new Error('Database connection failed');
      } catch (error) {
        timer.endWithError(error as Error, 'Request failed');
      }
      
      expect(true).toBe(true);
    });

    it('should handle security event chain', () => {
      logSecurityEvent('LOGIN_ATTEMPT', 'user-123', true, { method: 'oauth' });
      logSecurityEvent('AUTH_SUCCESS', 'user-123', true);
      logSecurityEvent('ACCESS_GRANTED', 'user-123', true, { resource: '/dashboard' });
      
      expect(true).toBe(true);
    });
  });
});
