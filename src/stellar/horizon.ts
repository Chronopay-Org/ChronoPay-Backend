/**
 * Stellar Horizon integration helpers.
 *
 * Re-exports the result-code translator and provides Horizon-specific
 * type helpers used across the application.
 */

export {
  TX_RESULT_CODES,
  OP_RESULT_CODES,
  parseHorizonErrorBody,
  translateHorizonResultCodes,
  translateHorizonError,
} from "../lib/stellarRpcFailure.js";

export type {
  HorizonResultCodes,
  HorizonErrorBody,
  TranslatedHorizonFailure,
} from "../lib/stellarRpcFailure.js";

/**
 * Returns `true` when the translated failure is retryable and the caller
 * should attempt to resubmit the transaction.
 */
export function isRetryableHorizonFailure(
  failure: import("../lib/stellarRpcFailure.js").TranslatedHorizonFailure,
): boolean {
  return failure.retryable;
}
