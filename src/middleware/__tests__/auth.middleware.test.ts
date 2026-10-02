// src/middleware/__tests__/auth.middleware.test.ts
/**
 * Test suite for authentication and authorization middleware.
 */
import { Request, Response } from 'express';
import { authenticateToken, authorize, authorizeOwnerOrAdmin, UserRole } from '../../middleware/auth.middleware.js';

// Mock dependencies
jest.mock('../../utils/jwt.js', () => ({
  verifyJwt: jest.fn(),
}));
jest.mock('../../config/config.service.js', () => ({
  configService: {
    getAllSecretVersions: jest.fn(),
  },
}));

import { verifyJwt } from '../../utils/jwt.js';
import { configService } from '../../config/config.service.js';

describe('authenticateToken', () => {
  const makeReq = (authHeader?: string) => ({
    headers: { authorization: authHeader },
  } as unknown as Request);

  const makeRes = () => {
    const res: Partial<Response> = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res as Response;
  };

  const nextFn = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.JWT_SECRET;
    (configService.getAllSecretVersions as jest.Mock).mockReturnValue([]);
    nextFn.mockReset();
  });

  test('returns 401 when Authorization header missing', async () => {
    const req = makeReq();
    const res = makeRes();
    await authenticateToken(req, res, nextFn);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Authorization header is required' });
    expect(nextFn).not.toHaveBeenCalled();
  });

  test('returns 401 when scheme is not Bearer', async () => {
    const req = makeReq('Basic abcdef');
    const res = makeRes();
    await authenticateToken(req, res, nextFn);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Authorization header must use the Bearer scheme' });
  });

  test('returns 401 when token missing after scheme', async () => {
    const req = makeReq('Bearer   ');
    const res = makeRes();
    await authenticateToken(req, res, nextFn);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Bearer token is missing' });
  });

  test('returns 500 when no JWT secret configured', async () => {
    // No env and configService returns empty
    const req = makeReq('Bearer validtoken');
    const res = makeRes();
    await authenticateToken(req, res, nextFn);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Authentication middleware error: JWT signing secret is not configured',
      message: 'Authentication middleware error',
    });
  });

  test('returns 401 when token verification fails', async () => {
    process.env.JWT_SECRET = 'secret';
    (verifyJwt as jest.Mock).mockRejectedValue(new Error('invalid'));
    const req = makeReq('Bearer badtoken');
    const res = makeRes();
    await authenticateToken(req, res, nextFn);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Invalid or expired token' });
  });

  test('sets req.user and calls next on valid token', async () => {
    process.env.JWT_SECRET = 'secret';
    const payload = { sub: '123', email: 'test@example.com', role: UserRole.USER } as any;
    (verifyJwt as jest.Mock).mockResolvedValue(payload);
    const req = makeReq('Bearer goodtoken') as Request & { user?: any };
    const res = makeRes();
    await authenticateToken(req, res, nextFn);
    expect(req.user).toBe(payload);
    expect(nextFn).toHaveBeenCalled();
  });
});

describe('authorize middleware', () => {
  const makeReq = (user?: any) => ({ user } as Request);
  const makeRes = () => {
    const res: Partial<Response> = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res as Response;
  };
  const nextFn = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();
    nextFn.mockReset();
  });

  test('returns 401 when no user attached', async () => {
    const req = makeReq();
    const res = makeRes();
    const middleware = authorize(UserRole.ADMIN);
    await middleware(req, res, nextFn);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Unauthorized' });
  });

  test('returns 403 when role not allowed', async () => {
    const req = makeReq({ role: UserRole.USER });
    const res = makeRes();
    const middleware = authorize(UserRole.ADMIN);
    await middleware(req, res, nextFn);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Insufficient permissions',
      message: 'This action requires one of the following roles: admin',
    });
  });

  test('calls next when role allowed', async () => {
    const req = makeReq({ role: UserRole.ADMIN });
    const res = makeRes();
    const middleware = authorize(UserRole.USER, UserRole.ADMIN);
    await middleware(req, res, nextFn);
    expect(nextFn).toHaveBeenCalled();
  });
});

describe('authorizeOwnerOrAdmin middleware', () => {
  const makeReq = (user?: any, params?: any) => ({
    user,
    ...params,
  } as Request);
  const makeRes = () => {
    const res: Partial<Response> = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res as Response;
  };
  const nextFn = jest.fn();

  const getResourceUserId = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();
    nextFn.mockReset();
  });

  test('returns 401 when no user', async () => {
    const req = makeReq(undefined);
    const res = makeRes();
    const middleware = authorizeOwnerOrAdmin(getResourceUserId);
    await middleware(req, res, nextFn);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Unauthorized' });
  });

  test('allows admin regardless of resource', async () => {
    const req = makeReq({ role: 'admin' });
    const res = makeRes();
    const middleware = authorizeOwnerOrAdmin(getResourceUserId);
    await middleware(req, res, nextFn);
    expect(nextFn).toHaveBeenCalled();
    expect(getResourceUserId).not.toHaveBeenCalled();
  });

  test('returns 404 when resource ID missing', async () => {
    getResourceUserId.mockReturnValue(null);
    const req = makeReq({ role: UserRole.USER, sub: '123' });
    const res = makeRes();
    const middleware = authorizeOwnerOrAdmin(getResourceUserId);
    await middleware(req, res, nextFn);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Resource not found' });
  });

  test('returns 403 when user not owner', async () => {
    getResourceUserId.mockReturnValue('other-id');
    const req = makeReq({ role: UserRole.USER, sub: '123' });
    const res = makeRes();
    const middleware = authorizeOwnerOrAdmin(getResourceUserId);
    await middleware(req, res, nextFn);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Access denied' });
  });

  test('calls next when user is owner', async () => {
    getResourceUserId.mockReturnValue('123');
    const req = makeReq({ role: UserRole.USER, sub: '123' });
    const res = makeRes();
    const middleware = authorizeOwnerOrAdmin(getResourceUserId);
    await middleware(req, res, nextFn);
    expect(nextFn).toHaveBeenCalled();
  });
});
