import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { createServer } from "http";
import { closePool } from "../db/connection.js";
import {
  gracefulShutdown,
  getActiveRequestCount,
  resetShutdownFlag,
  setServer,
  trackRequests,
} from "../index.js";

/**
 * Dedicated coverage for the process-lifecycle hooks exported by src/index.ts
 * (issue #1089): setServer, resetShutdownFlag, gracefulShutdown and the
 * request tracker that feeds the graceful-shutdown drain check.
 */

beforeEach(() => {
  resetShutdownFlag();
  setServer(undefined);
});

afterEach(async () => {
  await closePool().catch(() => {});
});

describe("setServer", () => {
  it("installs a server that gracefulShutdown subsequently closes", async () => {
    const server = createServer();
    const closed = jest.fn();
    server.on("close", closed);
    setServer(server);

    await gracefulShutdown();
    // allow the close callback to settle
    await new Promise((resolve) => setImmediate(resolve));

    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("clears a previously installed server when called with undefined", async () => {
    const server = createServer();
    const closed = jest.fn();
    server.on("close", closed);

    setServer(server);
    setServer(undefined);

    await gracefulShutdown();

    expect(closed).not.toHaveBeenCalled();
  });
});

describe("gracefulShutdown", () => {
  it("resolves when no server has been installed", async () => {
    await expect(gracefulShutdown()).resolves.toBeUndefined();
  });

  it("tolerates a null server instead of throwing", async () => {
    setServer(null);
    await expect(gracefulShutdown()).resolves.toBeUndefined();
  });

  it("tolerates a server whose close() throws synchronously", async () => {
    setServer({
      close: () => {
        throw new Error("socket already destroyed");
      },
    });

    await expect(gracefulShutdown()).resolves.toBeUndefined();
  });

  it("is idempotent until resetShutdownFlag is called", async () => {
    const first = createServer();
    const firstClosed = jest.fn();
    first.on("close", firstClosed);
    setServer(first);

    await gracefulShutdown();
    await new Promise((resolve) => setImmediate(resolve));
    expect(firstClosed).toHaveBeenCalledTimes(1);

    // A second call is a no-op while the shutting-down flag is set.
    await gracefulShutdown();
    await new Promise((resolve) => setImmediate(resolve));
    expect(firstClosed).toHaveBeenCalledTimes(1);

    const second = createServer();
    const secondClosed = jest.fn();
    second.on("close", secondClosed);
    setServer(second);

    resetShutdownFlag();
    await gracefulShutdown();
    await new Promise((resolve) => setImmediate(resolve));
    expect(secondClosed).toHaveBeenCalledTimes(1);
  });

  it("resolves when the server is already closed", async () => {
    const server = createServer();
    setServer(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await expect(gracefulShutdown()).resolves.toBeUndefined();
  });
});

describe("trackRequests", () => {
  function makeRes() {
    const handlers: Record<string, () => void> = {};
    return {
      handlers,
      res: {
        on: (event: string, cb: () => void) => {
          handlers[event] = cb;
        },
      },
    };
  }

  it("increments on entry and decrements once the response finishes", () => {
    const baseline = getActiveRequestCount();
    const { handlers, res } = makeRes();
    const next = jest.fn();

    trackRequests({}, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(getActiveRequestCount()).toBe(baseline + 1);

    handlers.finish();
    expect(getActiveRequestCount()).toBe(baseline);
  });

  it("does not under-count when finish and close both fire", () => {
    const baseline = getActiveRequestCount();
    const { handlers, res } = makeRes();

    trackRequests({}, res, () => {});

    handlers.finish();
    handlers.close();

    expect(getActiveRequestCount()).toBe(baseline);
  });

  it("falls back to the close event when finish never arrives", () => {
    const baseline = getActiveRequestCount();
    const { handlers, res } = makeRes();

    trackRequests({}, res, () => {});
    expect(getActiveRequestCount()).toBe(baseline + 1);

    handlers.close();
    expect(getActiveRequestCount()).toBe(baseline);
  });
});
