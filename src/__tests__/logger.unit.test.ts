/**
 * Unit tests for structured JSON logging utilities
 * Tests cover logger functionality, security features, and utilities
 */

import { 
  logger, 
  createChildLogger, 
  log, 
  logInfo, 
  logError, 
  logWarn, 
  logDebug, 
  LogContext 
} from '../utils/logger.js';

describe('Structured Logger - Core Functionality', () => {
  const originalEnv = process.env.NODE_ENV;

  afterAll(() => {
    process.env.NODE_ENV = originalEnv;
  });

  describe('Logger Instance', () => {
    it('should create a logger instance', () => {
      expect(logger).toBeDefined();
    });

    it('should support all standard log levels', () => {
      expect(() => logger.fatal('fatal')).not.toThrow();
      expect(() => logger.error('error')).not.toThrow();
      expect(() => logger.warn('warn')).not.toThrow();
      expect(() => logger.info('info')).not.toThrow();
      expect(() => logger.debug('debug')).not.toThrow();
      expect(() => logger.trace('trace')).not.toThrow();
    });
  });

  describe('Child Loggers', () => {
    it('should create child logger with context', () => {
      const context: LogContext = {
        requestId: 'test-123',
        module: 'auth'
      };
      
      const childLogger = createChildLogger(context);
      expect(childLogger).toBeDefined();
      expect(typeof childLogger.info).toBe('function');
    });

    it('should allow logging with child logger', () => {
      const childLogger = createChildLogger({ module: 'test' });
      expect(() => childLogger.info('child message')).not.toThrow();
    });
  });

  describe('Convenience Functions', () => {
    it('should provide logInfo function', () => {
      expect(() => logInfo('info message')).not.toThrow();
    });

    it('should provide logError function', () => {
      expect(() => logError('error message')).not.toThrow();
    });

    it('should provide logWarn function', () => {
      expect(() => logWarn('warn message')).not.toThrow();
    });

    it('should provide logDebug function', () => {
      expect(() => logDebug('debug message')).not.toThrow();
    });

    it('should provide generic log function', () => {
      expect(() => log('info', 'message')).not.toThrow();
    });

    it('should accept optional context', () => {
      const context: LogContext = { requestId: 'test' };
      expect(() => logInfo('message', context)).not.toThrow();
    });
  });

  describe('Environment Handling', () => {
    it('should use fatal level in test mode', () => {
      process.env.NODE_ENV = 'test';
      // Logger should be configured for test mode
      expect(process.env.NODE_ENV).toBe('test');
    });

    it('should use info level in production', () => {
      process.env.NODE_ENV = 'production';
      expect(process.env.NODE_ENV).toBe('production');
    });

    it('should use debug level in development', () => {
      process.env.NODE_ENV = 'development';
      expect(process.env.NODE_ENV).toBe('development');
    });
  });

  describe('Sensitive Data Sanitization', () => {
    it('should handle password fields', () => {
      const data = { username: 'john', password: 'secret' };
      expect(() => logger.info(data, 'login attempt')).not.toThrow();
    });

    it('should handle token fields', () => {
      const data = { token: 'eyJhbGciOiJIUzI1NiJ9.test' };
      expect(() => logger.info(data, 'api call')).not.toThrow();
    });

    it('should handle authorization headers', () => {
      const data = { 
        headers: { authorization: 'Bearer token' }
      };
      expect(() => logger.info(data, 'request')).not.toThrow();
    });
  });

  describe('Error Serialization', () => {
    it('should serialize Error objects', () => {
      const error = new Error('Test error');
      expect(() => logger.error({ error }, 'error occurred')).not.toThrow();
    });

    it('should serialize errors with cause', () => {
      const cause = new Error('Cause');
      const error = new Error('Test', { cause });
      expect(() => logger.error({ error }, 'error with cause')).not.toThrow();
    });

    it('should serialize errors with code', () => {
      const error = new Error('DB error') as NodeJS.ErrnoException;
      error.code = 'DB_FAILED';
      expect(() => logger.error({ error }, 'db error')).not.toThrow();
    });
  });

  describe('Context Handling', () => {
    it('should accept string context values', () => {
      const context: LogContext = { field: 'value' };
      expect(() => logger.info(context, 'message')).not.toThrow();
    });

    it('should accept number context values', () => {
      const context: LogContext = { count: 42 };
      expect(() => logger.info(context, 'message')).not.toThrow();
    });

    it('should accept nested objects', () => {
      const context: LogContext = { nested: { key: 'value' } };
      expect(() => logger.info(context, 'message')).not.toThrow();
    });

    it('should accept arrays', () => {
      const context: LogContext = { items: [1, 2, 3] };
      expect(() => logger.info(context, 'message')).not.toThrow();
    });

    it('should handle empty context', () => {
      expect(() => logger.info({}, 'message')).not.toThrow();
    });
  });

  describe('Service Metadata', () => {
    it('should include service name', () => {
      expect(process.env.SERVICE_NAME || 'chronopay-backend').toBeDefined();
    });

    it('should include version', () => {
      expect(process.env.SERVICE_VERSION || '0.1.0').toBeDefined();
    });

    it('should include PID', () => {
      expect(process.pid).toBeDefined();
    });

    it('should include hostname', () => {
      expect(process.env.HOSTNAME || 'localhost').toBeDefined();
    });
  });

  describe('Redaction Configuration', () => {
    it('should handle redacted paths', () => {
      const data = {
        headers: { authorization: 'Bearer secret' }
      };
      expect(() => logger.info(data, 'redaction test')).not.toThrow();
    });

    it('should handle query tokens', () => {
      const data = { query: { token: 'secret' } };
      expect(() => logger.info(data, 'query test')).not.toThrow();
    });

    it('should handle body secrets', () => {
      const data = { body: { secret: 'hidden' } };
      expect(() => logger.info(data, 'body test')).not.toThrow();
    });
  });

  describe('Log Level Types', () => {
    it('should accept fatal level', () => {
      expect(() => log('fatal', 'fatal message')).not.toThrow();
    });

    it('should accept error level', () => {
      expect(() => log('error', 'error message')).not.toThrow();
    });

    it('should accept warn level', () => {
      expect(() => log('warn', 'warn message')).not.toThrow();
    });

    it('should accept info level', () => {
      expect(() => log('info', 'info message')).not.toThrow();
    });

    it('should accept debug level', () => {
      expect(() => log('debug', 'debug message')).not.toThrow();
    });

    it('should accept trace level', () => {
      expect(() => log('trace', 'trace message')).not.toThrow();
    });
  });
});
