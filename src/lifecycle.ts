import type { RequestHandler } from "express";
import type { Server } from "node:http";
import { logger } from "./utils/logger.js";

type CloseHook = { name: string; close: () => void | Promise<void> };
type HttpServer = Pick<Server, "close"> & Partial<Pick<Server, "closeAllConnections">>;

/** Owns one process's request accounting and bounded, shared shutdown sequence. */
export class ApplicationLifecycle {
  private server?: HttpServer;
  private hooks: CloseHook[] = [];
  private activeRequests = 0;
  private closing = false;
  private shutdownPromise?: Promise<void>;
  private resourcesPromise?: Promise<void>;

  constructor(
    private readonly resources: CloseHook[],
    readonly timeoutMs = 30_000,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new RangeError("SHUTDOWN_TIMEOUT_MS must be a positive 32-bit integer");
    }
  }

  readonly trackRequests: RequestHandler = (_req, res, next) => {
    this.activeRequests++;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      this.activeRequests--;
      res.removeListener("finish", done);
      res.removeListener("close", done);
    };
    res.once("finish", done);
    res.once("close", done);
    next();
  };

  get isShuttingDown(): boolean {
    return this.closing;
  }
  getActiveRequestCount(): number {
    return this.activeRequests;
  }
  setServer(server?: HttpServer): void {
    this.server = server;
  }

  registerStop(name: string, close: CloseHook["close"]): void {
    this.hooks.push({ name, close });
  }

  /** Test isolation only; does not restart any stopped workers. */
  resetShutdownFlag(): void {
    this.closing = false;
    this.shutdownPromise = undefined;
    this.resourcesPromise = undefined;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    logger.info(
      { event: "shutdown.started", activeRequests: this.activeRequests },
      "shutdown started",
    );

    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        logger.error(
          { event: "shutdown.timeout", activeRequests: this.activeRequests },
          "shutdown deadline exceeded",
        );
        this.server?.closeAllConnections?.();
        // Best effort after forcibly closing HTTP. The signal handler also has a
        // hard exit fallback if a worker or driver never resolves its close.
        void this.closeResources().catch(() => {});
        reject(new Error("Graceful shutdown timed out"));
      }, this.timeoutMs);
    });

    // Publish the shared promise before invoking hooks that may re-enter shutdown.
    this.shutdownPromise = Promise.race([
      Promise.resolve().then(() => this.performShutdown()),
      deadline,
    ]).finally(() => clearTimeout(timer));
    return this.shutdownPromise;
  }

  private async closeHooks(hooks: CloseHook[]): Promise<void> {
    const results = await Promise.allSettled(
      hooks.map(async (hook) => {
        try {
          await hook.close();
        } catch (err) {
          logger.error(
            { event: "shutdown.close_failed", resource: hook.name, err },
            "shutdown close failed",
          );
          throw err;
        }
      }),
    );
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((r) => r.reason),
        "Shutdown close failed",
      );
  }

  private closeResources(): Promise<void> {
    return (this.resourcesPromise ??= this.closeHooks(this.resources));
  }

  private async performShutdown(): Promise<void> {
    // Start close immediately to stop accepting traffic. Its callback waits for
    // existing HTTP requests, so they retain their DB/Redis access while draining.
    const httpClosed = new Promise<void>((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => {
        if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(err);
        else resolve();
      });
    });
    // Attach a handler immediately: a worker stop may outlive an HTTP close error.
    const results = await Promise.allSettled([this.closeHooks(this.hooks), httpClosed]);
    const resources = await Promise.allSettled([this.closeResources()]);
    const failures = [...results, ...resources].filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((r) => r.reason),
        "Graceful shutdown failed",
      );
    logger.info(
      { event: "shutdown.completed", activeRequests: this.activeRequests },
      "shutdown completed",
    );
  }
}

type SignalTarget = Pick<NodeJS.Process, "once" | "removeListener">;

/** Installs one bounded shutdown for either signal; returns listener cleanup. */
export function registerShutdownSignals(
  shutdown: () => Promise<void>,
  options: { target?: SignalTarget; exit?: (code: number) => void; timeoutMs?: number } = {},
): () => void {
  const target = options.target ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let started = false;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    target.removeListener("SIGTERM", onTerm);
    target.removeListener("SIGINT", onInt);
    clearTimeout(timer);
  };
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    dispose();
    exit(code);
  };
  const start = (signal: string) => {
    if (started) return;
    started = true;
    logger.info({ event: "shutdown.signal", signal }, "shutdown signal received");
    timer = setTimeout(() => {
      logger.error({ event: "shutdown.forced_exit" }, "forcing exit after shutdown timeout");
      finish(1);
    }, options.timeoutMs ?? 31_000);
    Promise.resolve()
      .then(shutdown)
      .then(
        () => finish(0),
        (err) => {
          logger.error({ event: "shutdown.failed", err }, "graceful shutdown failed");
          finish(1);
        },
      );
  };
  // Rearm once listeners during draining so another OS signal cannot fall back
  // to Node's immediate default termination halfway through resource cleanup.
  function onTerm() {
    target.once("SIGTERM", onTerm);
    start("SIGTERM");
  }
  function onInt() {
    target.once("SIGINT", onInt);
    start("SIGINT");
  }
  target.once("SIGTERM", onTerm);
  target.once("SIGINT", onInt);
  return dispose;
}
