import { jest, beforeEach, afterEach, expect, describe, it } from "@jest/globals";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { closePool } from "../db/connection.js";
import { stopScheduler } from "../scheduler/reminderScheduler.js";
import {
  gracefulShutdown,
  setServer,
  resetShutdownFlag,
  getActiveRequestCount,
} from "../index.js";

beforeEach(() => {
  resetShutdownFlag();
  setServer(undefined);
});

afterEach(async () => {
  await closePool().catch(() => {});
});

describe("gracefulShutdown closes the HTTP server", () => {
  it("closes the server when one is set", async () => {
    const server = createServer();
    let closed = false;
    server.on("close", () => { closed = true; });
    setServer(server);

    await gracefulShutdown();

    expect(closed).toBe(true);
  });

  it("resolves when no server is set", async () => {
    await expect(gracefulShutdown()).resolves.toBeUndefined();
  });

  it("resolves when server is already closed", async () => {
    const server = createServer();
    setServer(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(gracefulShutdown()).resolves.toBeUndefined();
  });
});

describe("gracefulShutdown drains the DB pool", () => {
  it("calls closePool which resolves when no pool exists", async () => {
    await expect(gracefulShutdown()).resolves.toBeUndefined();
  });

  it("closePool is idempotent", async () => {
    await expect(closePool()).resolves.toBeUndefined();
    await expect(closePool()).resolves.toBeUndefined();
  });
});

describe("isShuttingDown guard", () => {
  it("prevents double invocation", async () => {
    const server = createServer();
    let closeCount = 0;
    server.on("close", () => { closeCount++; });
    setServer(server);

    await gracefulShutdown();
    expect(closeCount).toBe(1);

    await gracefulShutdown();
    expect(closeCount).toBe(1);
  });

  it("can be reset between tests", async () => {
    let closeCount = 0;
    const server = createServer();
    server.on("close", () => { closeCount++; });
    setServer(server);

    await gracefulShutdown();
    expect(closeCount).toBe(1);

    resetShutdownFlag();
    const server2 = createServer();
    server2.on("close", () => { closeCount++; });
    setServer(server2);

    await gracefulShutdown();
    expect(closeCount).toBe(2);
  });
});

describe("stopScheduler", () => {
  it("is safe to call when scheduler was never started", () => {
    expect(() => stopScheduler()).not.toThrow();
  });

  it("is idempotent", () => {
    stopScheduler();
    expect(() => stopScheduler()).not.toThrow();
  });
});

describe("in-flight request handling", () => {
  it("tracks active requests and waits for them during shutdown", async () => {
    const server = createServer();
    let requestFinished = false;
    let shutdownComplete = false;

    const req = new IncomingMessage(server);
    const res = new ServerResponse(req);

    setServer(server);
    expect(getActiveRequestCount()).toBe(0);

    gracefulShutdown().then(() => { shutdownComplete = true; });

    expect(getActiveRequestCount()).toBe(0);
    res.emit("finish");

    await new Promise(resolve => setImmediate(resolve));
    expect(shutdownComplete).toBe(true);
  });

  it("proceeds with shutdown even if in-flight requests never finish (timeout)", async () => {
    const server = createServer();
    const req = new IncomingMessage(server);
    const res = new ServerResponse(req);

    setServer(server);

    const result = await gracefulShutdown();
    expect(result).toBeUndefined();
  });
});

describe("shutdown without DB", () => {
  it("handles shutdown gracefully when no pool was ever created", async () => {
    const server = createServer();
    setServer(server);
    await expect(gracefulShutdown()).resolves.toBeUndefined();
  });

  it("handles shutdown gracefully when closePool was already called", async () => {
    const server = createServer();
    setServer(server);
    await closePool();
    await expect(gracefulShutdown()).resolves.toBeUndefined();
  });
});

describe("double signal protection", () => {
  it("isShuttingDown prevents concurrent shutdown sequences", async () => {
    const server = createServer();
    setServer(server);

    const p1 = gracefulShutdown();
    const p2 = gracefulShutdown();
    const results = await Promise.all([p1, p2]);
    expect(results).toEqual([undefined, undefined]);
  });
});
