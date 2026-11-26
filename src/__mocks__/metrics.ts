/**
 * Manual Jest mock for src/metrics.ts.
 *
 * Uses plain objects with no-op functions so prom-client is never loaded.
 * Tests that need to spy on specific methods should use jest.spyOn() on the
 * exported objects, which creates spies in the test file's Jest context and
 * survives clearAllMocks correctly.
 */

function noop() {}
function noopLabels() {
  return { inc: noop, set: noop, labels: noopLabels };
}

function makePlain() {
  return { inc: noop, set: noop, labels: noopLabels };
}

export const treasuryBalance      = makePlain();
export const treasuryDrainSeverity = makePlain();
export const treasuryPollFailures  = makePlain();
export const treasuryUnknownAsset  = makePlain();

export const register = {};
export const metricsMiddleware = noop;
