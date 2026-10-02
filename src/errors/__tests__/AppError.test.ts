import { AppError, BadRequestError, ValidationError, isAppError, getStatusCode } from '../../errors/AppError.js';
import { ERROR_CODES } from '../../errors/errorCodes.js';

describe('AppError and related classes', () => {
  test('AppError toJSON produces correct envelope', () => {
    const err = new AppError('Something went wrong', 418, 'CUSTOM_ERROR', true, { info: 'detail' }, 'some.key' as any);
    const envelope = err.toJSON();
    expect(envelope).toMatchObject({
      success: false,
      code: 'CUSTOM_ERROR',
      message: 'Something went wrong',
      error: 'Something went wrong',
      details: { info: 'detail' },
    });
    expect(typeof envelope.timestamp).toBe('string');
  });

  test('BadRequestError defaults', () => {
    const badReq = new BadRequestError();
    expect(badReq.statusCode).toBe(ERROR_CODES.BAD_REQUEST.status);
    expect(badReq.code).toBe(ERROR_CODES.BAD_REQUEST.code);
    expect(badReq.isPublic()).toBe(true);
    const envelope = badReq.toJSON();
    expect(envelope.code).toBe(ERROR_CODES.BAD_REQUEST.code);
    expect(envelope.message).toBe('Bad Request');
  });

  test('ValidationError inherits correctly', () => {
    const valErr = new ValidationError('Invalid data', { field: 'name' }, 'validation.key' as any);
    expect(valErr.statusCode).toBe(ERROR_CODES.VALIDATION_ERROR.status);
    expect(valErr.code).toBe(ERROR_CODES.VALIDATION_ERROR.code);
    expect(valErr.isPublic()).toBe(true);
    const json = valErr.toJSON();
    expect(json.details).toEqual({ field: 'name' });
  });

  test('Utility functions detect AppError', () => {
    const err = new AppError('test');
    expect(isAppError(err)).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(getStatusCode(err)).toBe(err.statusCode);
    expect(getStatusCode(new Error('plain'))).toBe(500);
  });
});
