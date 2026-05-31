/**
 * Centralized dependency status provider.
 *
 * Exposes a single `isDependencyAvailable(dep)` function that returns whether
 * a named dependency (redis | db) is currently healthy.  Callers never touch
 * the underlying clients directly, which keeps the status logic in one place
 * and makes it easy to stub in tests.
 *
 * Security note: status checks never surface connection strings, credentials,
 * or internal error details to callers.
 */

import { isRedisReady } from "../cache/redisClient.js";
import type { DependencyFaultName } from "../metrics.js";

export type Dependency = "redis" | "db";
type ProbeResult = boolean | { available: boolean; fault?: DependencyFaultName };

/**
 * Replaceable Redis-ready probe — defaults to `isRedisReady()`.
 * Tests override this via `_setRedisReadyProbe()`.
 * @internal
 */
let _redisReadyProbe: () => boolean = () => isRedisReady();
const _lastFault: Record<Dependency, DependencyFaultName | null> = {
  redis: null,
  db: null,
};

/** @internal — for test injection only */
export function _setRedisReadyProbe(probe: () => boolean): void {
  _redisReadyProbe = probe;
}

/**
 * Replaceable DB-ready probe — defaults to a live pool query.
 * Tests override this via `_setDbReadyProbe()`.
 * @internal
 */
let _dbReadyProbe: () => Promise<ProbeResult> = async () => {
  try {
    const { getPool } = await import("../db/connection.js");
    await getPool().query("SELECT 1");
    return true;
  } catch {
    return false;
  }
};

/** @internal — for test injection only */
export function _setDbReadyProbe(probe: () => Promise<ProbeResult>): void {
  _dbReadyProbe = probe;
}

export function getLastDependencyFault(dep: Dependency): DependencyFaultName | null {
  return _lastFault[dep];
}

function normalizeProbeResult(dep: Dependency, result: ProbeResult): boolean {
  const available = typeof result === "boolean" ? result : result.available;
  if (available) {
    _lastFault[dep] = null;
    return true;
  }

  _lastFault[dep] =
    typeof result === "boolean"
      ? (dep === "redis" ? "disconnect" : "timeout")
      : result.fault ?? (dep === "redis" ? "disconnect" : "timeout");
  return false;
}

/**
 * Returns true when the named dependency is available.
 *
 * - `redis`: delegates to the Redis-ready probe (sync).
 * - `db`:    runs a lightweight `SELECT 1` probe (async).
 */
export async function isDependencyAvailable(dep: Dependency): Promise<boolean> {
  if (dep === "redis") {
    return normalizeProbeResult(dep, _redisReadyProbe());
  }
  return normalizeProbeResult(dep, await _dbReadyProbe());
}
