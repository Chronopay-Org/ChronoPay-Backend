import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import express, { type Request, type Response } from "express";
import request from "supertest";
import { ApplicationLifecycle, registerShutdownSignals } from "../lifecycle.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => jest.useRealTimers());

describe("application shutdown", () => {
  it("stops accepting traffic but keeps resources until a real HTTP request drains", async () => {
    const entered = deferred();
    const release = deferred();
    const close = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const stop = jest.fn();
    const lifecycle = new ApplicationLifecycle([{ name: "db", close }]);
    lifecycle.registerStop("worker", stop);
    const app = express();
    app.use(lifecycle.trackRequests);
    app.get("/slow", async (_req, res) => {
      entered.resolve();
      await release.promise;
      res.send("done");
    });
    const server = createServer(app);
    lifecycle.setServer(server);
    const response = request(server)
      .get("/slow")
      .then((value) => value);
    await entered.promise;
    expect(lifecycle.getActiveRequestCount()).toBe(1);
    const closing = lifecycle.shutdown();
    expect(lifecycle.shutdown()).toBe(closing);
    await Promise.resolve();
    expect(server.listening).toBe(false);
    expect(close).not.toHaveBeenCalled();
    release.resolve();
    expect((await response).text).toBe("done");
    await closing;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(lifecycle.getActiveRequestCount()).toBe(0);
  });

  it("settles request accounting only once across finish and close", () => {
    const lifecycle = new ApplicationLifecycle([]);
    const response = new EventEmitter();
    lifecycle.trackRequests({} as Request, response as unknown as Response, () => {});
    expect(lifecycle.getActiveRequestCount()).toBe(1);
    response.emit("close");
    response.emit("finish");
    expect(lifecycle.getActiveRequestCount()).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    expect(response.listenerCount("finish")).toBe(0);
  });

  it("publishes one shared close even when a worker re-enters shutdown", async () => {
    const lifecycle = new ApplicationLifecycle([]);
    let reentered: Promise<void> | undefined;
    lifecycle.registerStop("reentrant", () => {
      reentered = lifecycle.shutdown();
    });
    const pending = lifecycle.shutdown();
    await pending;
    expect(reentered).toBe(pending);
  });

  it("attempts every resource close even after a stop or driver fails", async () => {
    const db = jest.fn<() => Promise<void>>().mockRejectedValue(new Error("driver failure"));
    const redis = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const stop = jest.fn(() => {
      throw new Error("worker failure");
    });
    const lifecycle = new ApplicationLifecycle([
      { name: "db", close: db },
      { name: "redis", close: redis },
    ]);
    lifecycle.registerStop("worker", stop);
    await expect(lifecycle.shutdown()).rejects.toThrow("Graceful shutdown failed");
    await expect(lifecycle.shutdown()).rejects.toThrow();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(db).toHaveBeenCalledTimes(1);
    expect(redis).toHaveBeenCalledTimes(1);
  });

  it("bounds a stuck HTTP drain and attempts resource cleanup", async () => {
    jest.useFakeTimers();
    const closeAllConnections = jest.fn();
    const close = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const lifecycle = new ApplicationLifecycle([{ name: "db", close }], 50);
    lifecycle.setServer({ close: () => undefined, closeAllConnections } as unknown as ReturnType<
      typeof createServer
    >);
    const failure = expect(lifecycle.shutdown()).rejects.toThrow("timed out");
    await jest.advanceTimersByTimeAsync(50);
    await failure;
    expect(closeAllConnections).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("bounds a hung worker stop without skipping best-effort cleanup", async () => {
    jest.useFakeTimers();
    const close = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const lifecycle = new ApplicationLifecycle([{ name: "redis", close }], 50);
    lifecycle.registerStop("stuck", () => new Promise<void>(() => {}));
    const failure = expect(lifecycle.shutdown()).rejects.toThrow("timed out");
    await jest.advanceTimersByTimeAsync(50);
    await failure;
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("process signal registration", () => {
  it.each(["SIGTERM", "SIGINT"])(
    "runs one shutdown for repeated %s and mixed signals",
    async (signal) => {
      const target = new EventEmitter();
      const gate = deferred();
      const shutdown = jest.fn(() => gate.promise);
      const exit = jest.fn();
      registerShutdownSignals(shutdown, { target: target as unknown as NodeJS.Process, exit });
      target.emit(signal);
      target.emit(signal);
      target.emit(signal === "SIGTERM" ? "SIGINT" : "SIGTERM");
      await Promise.resolve();
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
      expect(target.listenerCount("SIGTERM")).toBe(1);
      gate.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
      expect(target.listenerCount("SIGTERM")).toBe(0);
      expect(target.listenerCount("SIGINT")).toBe(0);
    },
  );

  it("exits unsuccessfully on shutdown rejection", async () => {
    const target = new EventEmitter();
    const exit = jest.fn();
    registerShutdownSignals(() => Promise.reject(new Error("close failed")), {
      target: target as unknown as NodeJS.Process,
      exit,
    });
    target.emit("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("forces an unsuccessful exit if shutdown never resolves", async () => {
    jest.useFakeTimers();
    const target = new EventEmitter();
    const exit = jest.fn();
    registerShutdownSignals(() => new Promise<void>(() => {}), {
      target: target as unknown as NodeJS.Process,
      exit,
      timeoutMs: 50,
    });
    target.emit("SIGTERM");
    await jest.advanceTimersByTimeAsync(50);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(target.listenerCount("SIGTERM")).toBe(0);
  });
});
