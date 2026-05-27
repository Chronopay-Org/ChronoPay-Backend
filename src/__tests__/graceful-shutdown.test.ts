import { jest, beforeEach, afterEach, expect, describe, it } from "@jest/globals";
import { createServer } from "http";
import { closePool } from "../db/connection.js";
import { stopScheduler } from "../scheduler/reminderScheduler.js";
import {
  gracefulShutdown,
  setServer,
  resetShutdownFlag,
} from "../index.js";

beforeEach(() => {
  resetShutdownFlag();
  setServer(undefined);
});

afterEach(async () => {
  await closePool().catch(() => {});
});

// ─── HTTP server ────────────────────────────────────────────────────────────

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

// ─── Database pool ──────────────────────────────────────────────────────────

describe("gracefulShutdown drains the DB pool", () => {
  it("calls closePool which resolves when no pool exists", async () => {
    // closePool is safe to call even without a pool — it's a no-op.
    await expect(gracefulShutdown()).resolves.toBeUndefined();
  });

  it("closePool is idempotent", async () => {
    await expect(closePool()).resolves.toBeUndefined();
    await expect(closePool()).resolves.toBeUndefined();
  });
});

// ─── Double-call guard ──────────────────────────────────────────────────────

describe("isShuttingDown guard", () => {
  it("prevents double invocation", async () => {
    // Track calls to stopScheduler indirectly via a counter module
    const server = createServer();
    let closeCount = 0;
    server.on("close", () => { closeCount++; });
    setServer(server);

    await gracefulShutdown();
    expect(closeCount).toBe(1);

    // Second call should not close again
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

// ─── stopScheduler and closePool standalone ─────────────────────────────────

describe("stopScheduler", () => {
  it("is safe to call when scheduler was never started", () => {
    expect(() => stopScheduler()).not.toThrow();
  });

  it("is idempotent", () => {
    stopScheduler();
    expect(() => stopScheduler()).not.toThrow();
  });
});
