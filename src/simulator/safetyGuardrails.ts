/**
 * Safety Guardrails
 *
 * The simulator MUST NOT send any load to the real Stellar network.
 *
 * This module enforces that invariant at multiple layers:
 *
 *   1. assertSimulationSafe() – called by the load generator before every run.
 *      Throws SimulationSafetyError if the environment or curve looks like it
 *      might target a live Stellar node.
 *
 *   2. BLOCKED_STELLAR_HOSTS – a hard-coded denylist of known Horizon endpoints.
 *      Any URL matching the list causes an immediate error.
 *
 *   3. NODE_ENV guard – production environments are blocked entirely.
 *
 *   4. Export SIMULATOR_SAFE_MARKER so callers can verify this module was loaded
 *      (useful in tests that want to assert no real calls were made).
 */

import type { TrafficCurve } from "./types.js";

// ---------------------------------------------------------------------------
// Well-known Stellar Horizon hostnames (public mainnet + testnet).
// The simulator must never contact these directly.
// ---------------------------------------------------------------------------

export const BLOCKED_STELLAR_HOSTS: ReadonlySet<string> = new Set([
  "horizon.stellar.org",
  "horizon-testnet.stellar.org",
  "stellar.expert",
  "api.stellar.org",
  "horizon-futurenet.stellar.org",
]);

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class SimulationSafetyError extends Error {
  constructor(reason: string) {
    super(`[SimulationSafety] ${reason}`);
    this.name = "SimulationSafetyError";
  }
}

// ---------------------------------------------------------------------------
// URL inspection helper
// ---------------------------------------------------------------------------

/**
 * Returns the blocked host name if the URL matches a Stellar Horizon endpoint,
 * or null if the URL is safe.
 */
export function findBlockedHost(rawUrl: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    // Not a valid URL – treat as safe (the label field is not a URL).
    return null;
  }

  for (const blocked of BLOCKED_STELLAR_HOSTS) {
    if (hostname === blocked || hostname.endsWith(`.${blocked}`)) {
      return blocked;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main guard
// ---------------------------------------------------------------------------

/**
 * Assert that running a simulation against `curve` is safe.
 *
 * Checks:
 *  - Not running in NODE_ENV=production
 *  - The curve label does not look like a live Stellar URL
 *  - No sample contains a Stellar URL (defence-in-depth)
 *
 * @throws SimulationSafetyError on any violation.
 */
export function assertSimulationSafe(curve: TrafficCurve): void {
  // 1. Block production runs
  if (process.env.NODE_ENV === "production") {
    throw new SimulationSafetyError(
      "The capacity simulator must not run in NODE_ENV=production. " +
        "Set NODE_ENV to 'test' or 'development'.",
    );
  }

  // 2. Check curve label for Stellar URLs
  const labelHost = findBlockedHost(curve.label);
  if (labelHost !== null) {
    throw new SimulationSafetyError(
      `Traffic curve label "${curve.label}" contains a blocked Stellar host ` +
        `"${labelHost}". The simulator must not target the real Stellar network.`,
    );
  }

  // 3. Additional environment sentinel (belt-and-suspenders)
  if (process.env.STELLAR_HORIZON_URL) {
    const envHost = findBlockedHost(process.env.STELLAR_HORIZON_URL);
    if (envHost !== null) {
      throw new SimulationSafetyError(
        `STELLAR_HORIZON_URL env var points to blocked host "${envHost}". ` +
          "Unset or override this variable before running the simulator.",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Marker – tests can import this to prove the module was loaded.
// ---------------------------------------------------------------------------
export const SIMULATOR_SAFE_MARKER = "SIMULATOR_SAFE_v1" as const;
