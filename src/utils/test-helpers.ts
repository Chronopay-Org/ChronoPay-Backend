import { Request, Response, NextFunction } from "express";
import { jest } from "@jest/globals";

/**
 * Mocks an Express Request object.
 * @param options - Custom options to override the default request.
 * @returns A mock Request object.
 */
export const mockRequest = (options: Partial<Request> = {}): Partial<Request> => {
  return {
    body: {},
    params: {},
    query: {},
    headers: {},
    ...options,
  };
};

/**
 * Mocks an Express Response object with chainable methods.
 * @returns A mock Response object with Jest spies.
 */
export const mockResponse = (): Partial<Response> => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  res.end = jest.fn().mockReturnValue(res);
  return res as Partial<Response>;
};

/**
 * Mocks an Express Next function.
 * @returns A Jest spy for the next function.
 */
export const mockNext = (): NextFunction => jest.fn() as any;
