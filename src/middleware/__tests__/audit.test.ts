import { jest } from '@jest/globals';
import request from 'supertest';
import express, { Request, Response } from 'express';
import { auditMiddleware } from '../audit.js';
import { defaultAuditLogger } from '../../services/auditLogger.js';
import { 
  validateAuditEvent, 
  redactSensitiveData, 
  validatePayloadV1, 
  encodeAuditEvent, 
  decodeAuditEvent, 
  migrateLegacyEntry 
} from '../../utils/auditEventValidator.js';
import { AuditEventV1 } from '../../types/auditEvent.js';

describe('auditMiddleware', () => {
  let app: express.Express;
  let auditSpy: any;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    
    // Reset the spy before each test
    auditSpy = jest.spyOn(defaultAuditLogger, 'log').mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    auditSpy.mockRestore();
  });

  it('should log an audit event when the request finishes', async () => {
    const action = 'TEST_ACTION';
    app.get('/test', auditMiddleware(action), (_req: Request, res: Response) => {
      res.status(200).json({ success: true });
    });

    await request(app).get('/test').expect(200);

    // Give some time for 'finish' event to fire and log to be called
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(auditSpy).toHaveBeenCalledWith(
      action,
      expect.objectContaining({
        method: 'GET',
      }),
      expect.objectContaining({
        resource: '/test',
        status: 200,
      })
    );
  });

  it('should redact sensitive data in the request body', async () => {
    const action = 'SENSITIVE_ACTION';
    app.post('/sensitive', auditMiddleware(action), (_req: Request, res: Response) => {
      res.status(201).json({ success: true });
    });

    const sensitiveBody = {
      username: 'user1',
      password: 'secret-password', // Sensitive
      token: 'secret-token', // Sensitive
      details: {
        pin: '1234', // Sensitive
        note: 'this is fine'
      }
    };

    await request(app)
      .post('/sensitive')
      .send(sensitiveBody)
      .expect(201);

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(auditSpy).toHaveBeenCalled();
    const [actionArg, dataArg] = auditSpy.mock.calls[0];
    
    expect(actionArg).toBe(action);
    expect(dataArg.body.password).toBe('***REDACTED***');
    expect(dataArg.body.token).toBe('***REDACTED***');
    expect(dataArg.body.details.pin).toBe('***REDACTED***');
    expect(dataArg.body.details.note).toBe('this is fine');
  });

  it('should not include body for GET requests', async () => {
    app.get('/no-body', auditMiddleware('GET_ACTION'), (_req: Request, res: Response) => {
      res.status(200).json({ success: true });
    });

    await request(app).get('/no-body').expect(200);
    await new Promise(resolve => setTimeout(resolve, 50));

    const data = auditSpy.mock.calls[0][1];
    expect(data.body).toBeUndefined();
  });

  it('should handle missing IP address', async () => {
    app.get('/no-ip', auditMiddleware('IP_ACTION'), (req: Request, res: Response) => {
      // Manually clear IP
      Object.defineProperty(req, 'ip', { value: undefined });
      Object.defineProperty(req, 'socket', { value: { remoteAddress: undefined } });
      res.status(200).json({ success: true });
    });

    await request(app).get('/no-ip').expect(200);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(auditSpy).toHaveBeenCalled();
    const options = auditSpy.mock.calls[0][2];
    expect(options.actorIp).toBeUndefined();
  });
});

describe('auditLogger and validator integration', () => {
  let fs: any;
  let mkdirSpy: any;
  let appendFileSpy: any;

  beforeEach(async () => {
    fs = await import('fs/promises');
    mkdirSpy = jest.spyOn(fs.default, 'mkdir').mockImplementation(() => Promise.resolve(''));
    appendFileSpy = jest.spyOn(fs.default, 'appendFile').mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    mkdirSpy.mockRestore();
    appendFileSpy.mockRestore();
  });

  it('should create valid audit events via the logger', async () => {
    const { AuditLogger } = await import('../../services/auditLogger.js');
    const logger = new AuditLogger({
      filePath: 'test-audit.log',
      service: 'test-service',
      environment: 'test'
    });

    await logger.log('TEST_VALIDATION', { method: 'POST', body: { foo: 'bar' } }, { status: 200, actorIp: '127.0.0.1' });

    expect(appendFileSpy).toHaveBeenCalled();
    const logLine = appendFileSpy.mock.calls[0][1] as string;
    const event = JSON.parse(logLine.trim()) as AuditEventV1;

    expect(() => validateAuditEvent(event)).not.toThrow();
    expect(event.action).toBe('TEST_VALIDATION');
    expect(event.data.method).toBe('POST');
  });

  it('should support legacy log format and migrate it', async () => {
    const { AuditLogger } = await import('../../services/auditLogger.js');
    const logger = new AuditLogger();
    
    await logger.log({
      action: 'LEGACY_ACTION',
      status: 200,
      resource: '/legacy',
      metadata: { method: 'GET', foo: 'bar' }
    });

    expect(appendFileSpy).toHaveBeenCalled();
    const logLine = appendFileSpy.mock.calls[0][1] as string;
    const event = JSON.parse(logLine.trim()) as AuditEventV1;

    expect(event.action).toBe('LEGACY_ACTION');
    expect(event.data.method).toBe('GET');
    expect((event.data as any).context.foo).toBe('bar');
  });

  it('should handle filesystem errors gracefully', async () => {
    appendFileSpy.mockRejectedValue(new Error('Disk full'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    
    const { AuditLogger } = await import('../../services/auditLogger.js');
    const logger = new AuditLogger();
    
    await expect(logger.log('ERROR_ACTION', {})).resolves.not.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to write to audit log:'), expect.any(Error));
    
    consoleSpy.mockRestore();
  });
});

describe('auditEventValidator edge cases', () => {
  it('redactSensitiveData should handle non-object/non-string types', () => {
    expect(redactSensitiveData(null)).toBe(null);
    expect(redactSensitiveData(undefined)).toBe(undefined);
    expect(redactSensitiveData(123)).toBe(123);
    expect(redactSensitiveData(true)).toBe(true);
    expect(redactSensitiveData(Symbol('test'))).toBe('***REDACTED***');
  });

  it('redactSensitiveData should handle arrays', () => {
    const data = ['safe', 'password'];
    expect(redactSensitiveData(data)).toEqual(['safe', 'password']);
    
    const objArray = [{ password: '123' }, { safe: 'abc' }];
    expect(redactSensitiveData(objArray)).toEqual([{ password: '***REDACTED***' }, { safe: 'abc' }]);
  });

  it('redactSensitiveData should redact long strings', () => {
    const longString = 'a'.repeat(300);
    expect(redactSensitiveData(longString)).toBe('***REDACTED***');
  });

  it('validateAuditEvent should throw for invalid envelope', () => {
    const base: any = {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      eventId: '550e8400-e29b-41d4-a716-446655440000',
      action: 'TEST',
      status: 200,
      data: {},
      service: 'test',
      environment: 'test'
    };

    const testInvalid = (patch: any, errorMsg: string | RegExp) => {
      expect(() => validateAuditEvent({ ...base, ...patch })).toThrow(errorMsg);
    };

    testInvalid({ version: undefined }, /version is required/);
    testInvalid({ timestamp: undefined }, /timestamp is required/);
    testInvalid({ timestamp: 'invalid-date' }, /timestamp must be in ISO 8601 format/);
    testInvalid({ eventId: undefined }, /eventId is required/);
    testInvalid({ eventId: 'invalid-uuid' }, /eventId must be a valid UUID v4/);
    testInvalid({ action: undefined }, /action is required/);
    testInvalid({ action: 'a'.repeat(300) }, /action must not exceed 256 characters/);
    testInvalid({ status: undefined }, /status is required/);
    testInvalid({ status: { invalid: true } }, /status must be a number or string/);
    testInvalid({ data: undefined }, /data is required/);
    testInvalid({ service: undefined }, /service is required/);
    testInvalid({ environment: undefined }, /environment is required/);
    testInvalid({ environment: 'invalid-env' }, /environment must be one of/);
    testInvalid({ actorIp: 'invalid-ip' }, /actorIp must be a valid IP address/);
    testInvalid({ resource: 'a'.repeat(3000) }, /resource must not exceed 2048 characters/);
  });

  it('validateAuditEvent should throw for unsupported version', () => {
    const invalidEvent: any = {
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      eventId: '550e8400-e29b-41d4-a716-446655440000',
      action: 'TEST',
      status: 200,
      data: {},
      service: 'test',
      environment: 'test'
    };
    expect(() => validateAuditEvent(invalidEvent)).toThrow(/Unsupported schema version/);
  });

  it('validatePayloadV1 should throw for invalid payload', () => {
    const testInvalid = (patch: any, errorMsg: string | RegExp) => {
      expect(() => validatePayloadV1(patch)).toThrow(errorMsg);
    };

    testInvalid({ method: 'INVALID' }, /method must be one of/);
    testInvalid({ method: 123 }, /method must be a string/);
    testInvalid({ body: 'not-an-object' }, /body must be an object/);
    testInvalid({ context: 'not-an-object' }, /context must be an object/);
    testInvalid({ userId: 123 }, /userId must be a string/);
    testInvalid({ sessionId: 123 }, /sessionId must be a string/);
  });

  it('validateAuditEvent should throw if payload is too large', () => {
    const largeData = { foo: 'a'.repeat(11 * 1024) };
    const event: any = {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      eventId: '550e8400-e29b-41d4-a716-446655440000',
      action: 'TEST',
      status: 200,
      data: largeData,
      service: 'test',
      environment: 'test'
    };
    expect(() => validateAuditEvent(event)).toThrow(/exceeds maximum allowed size/);
  });

  it('encodeAuditEvent and decodeAuditEvent should work', () => {
    const event: AuditEventV1 = {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      eventId: '550e8400-e29b-41d4-a716-446655440000',
      action: 'TEST',
      status: 200,
      data: { method: 'GET' },
      service: 'test',
      environment: 'test'
    };

    const encoded = encodeAuditEvent(event);
    expect(typeof encoded).toBe('string');
    
    const decoded = decodeAuditEvent(encoded);
    expect(decoded).toEqual(event);
  });

  it('decodeAuditEvent should throw for invalid JSON', () => {
    expect(() => decodeAuditEvent('invalid-json')).toThrow(/Invalid JSON format/);
  });

  it('migrateLegacyEntry should work', () => {
    const legacy = {
      timestamp: new Date().toISOString(),
      action: 'LEGACY',
      status: 200,
      resource: '/legacy',
      metadata: { method: 'GET', body: { foo: 'bar' } }
    };

    const migrated = migrateLegacyEntry(legacy, { service: 'new-service', environment: 'prod' });
    expect(migrated.version).toBe('1.0.0');
    expect(migrated.action).toBe('LEGACY');
    expect(migrated.data.method).toBe('GET');
    expect(migrated.service).toBe('new-service');
    expect(migrated.environment).toBe('prod');
  });

  it('isValidIPAddress helper should handle various formats', () => {
    const base: any = {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      eventId: '550e8400-e29b-41d4-a716-446655440000',
      action: 'TEST',
      status: 200,
      data: {},
      service: 'test',
      environment: 'test'
    };

    // Valid IPs
    expect(() => validateAuditEvent({ ...base, actorIp: '127.0.0.1' })).not.toThrow();
    expect(() => validateAuditEvent({ ...base, actorIp: '::1' })).not.toThrow();
    expect(() => validateAuditEvent({ ...base, actorIp: '::ffff:127.0.0.1' })).not.toThrow();
    expect(() => validateAuditEvent({ ...base, actorIp: '2001:0db8:85a3:0000:0000:8a2e:0370:7334' })).not.toThrow();
    expect(() => validateAuditEvent({ ...base, actorIp: '::' })).not.toThrow();

    // Invalid IPs
    expect(() => validateAuditEvent({ ...base, actorIp: 'not-an-ip' })).toThrow(/actorIp must be a valid IP address/);
    expect(() => validateAuditEvent({ ...base, actorIp: '127.0.0' })).toThrow(/actorIp must be a valid IP address/);
    expect(() => validateAuditEvent({ ...base, actorIp: '256.256.256.256' })).toThrow(/actorIp must be a valid IP address/);
  });
});
