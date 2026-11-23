/**
 * Horizon result-code translator for pathological ledger errors.
 *
 * Translates raw Horizon transaction/operation result codes (as returned in
 * the `extras.result_codes` field of a 400 Transaction Failed response) into
 * structured, user-facing error descriptions.
 *
 * Reference: https://developers.stellar.org/api/errors/result-codes
 */

// ─── Result code constants ────────────────────────────────────────────────────

/** Transaction-level result codes. */
export const TX_RESULT_CODES = {
  /** Transaction submitted after its time bounds. */
  TX_TOO_LATE: "tx_too_late",
  /** Sequence number does not match the source account's current sequence. */
  TX_BAD_SEQ: "tx_bad_seq",
  /** Transaction signature is invalid or missing. */
  TX_BAD_AUTH: "tx_bad_auth",
  /** One or more operations inside the transaction failed. */
  TX_FAILED: "tx_failed",
  /** Transaction was not submitted in time (too early). */
  TX_TOO_EARLY: "tx_too_early",
  /** Source account does not exist. */
  TX_NO_ACCOUNT: "tx_no_account",
  /** Insufficient fee for the network. */
  TX_INSUFFICIENT_FEE: "tx_insufficient_fee",
  /** Too many operations in the transaction. */
  TX_TOO_MANY_OPERATIONS: "tx_too_many_operations",
  /** Internal error in the Stellar core. */
  TX_INTERNAL_ERROR: "tx_internal_error",
} as const;

/** Operation-level result codes. */
export const OP_RESULT_CODES = {
  /** Authorization signature is not valid for this operation. */
  OP_BAD_AUTH: "op_bad_auth",
  /** Source account does not have enough balance to perform the operation. */
  OP_UNDERFUNDED: "op_underfunded",
  /** Operation does not exist or is not supported. */
  OP_NO_DESTINATION: "op_no_destination",
  /** Line would exceed its limit. */
  OP_LINE_FULL: "op_line_full",
  /** Source account has no trust for the asset. */
  OP_NO_TRUST: "op_no_trust",
  /** The operation is not currently authorized. */
  OP_NOT_AUTHORIZED: "op_not_authorized",
  /** Destination account is missing. */
  OP_NO_ACCOUNT: "op_no_account",
  /** Offer amount is below the minimum. */
  OP_OFFER_NOT_FOUND: "op_offer_not_found",
  /** Generic operation malformed. */
  OP_MALFORMED: "op_malformed",
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Raw `extras.result_codes` block from a Horizon 400 response. */
export interface HorizonResultCodes {
  transaction?: string;
  operations?: (string | null)[];
}

/**
 * Parsed shape of a Horizon "Transaction Failed" 400 error body.
 * Only the fields relevant to result-code translation are required.
 */
export interface HorizonErrorBody {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  extras?: {
    result_codes?: HorizonResultCodes;
    envelope_xdr?: string;
    result_xdr?: string;
  };
}

/** Structured translation of a Horizon ledger error. */
export interface TranslatedHorizonFailure {
  /** Machine-readable code (the primary result code that was matched). */
  code: string;
  /** Human-readable message safe to surface to end users. */
  userMessage: string;
  /** Whether the operation should be retried by the caller. */
  retryable: boolean;
  /**
   * The raw result codes extracted from the Horizon response, for logging/
   * debugging purposes.
   */
  rawCodes: HorizonResultCodes;
}

// ─── Per-code translation table ───────────────────────────────────────────────

interface CodeEntry {
  userMessage: string;
  retryable: boolean;
}

const TX_CODE_MAP: Record<string, CodeEntry> = {
  [TX_RESULT_CODES.TX_BAD_AUTH]: {
    userMessage:
      "The transaction could not be authorized. Please check your signing key and try again.",
    retryable: false,
  },
  [TX_RESULT_CODES.TX_TOO_LATE]: {
    userMessage:
      "The transaction expired before it was processed. Please resubmit with an updated time bound.",
    retryable: true,
  },
  [TX_RESULT_CODES.TX_BAD_SEQ]: {
    userMessage:
      "The transaction sequence number is out of date. Please refresh your account state and retry.",
    retryable: true,
  },
  [TX_RESULT_CODES.TX_TOO_EARLY]: {
    userMessage: "The transaction cannot be submitted yet — its minimum time bound has not been reached.",
    retryable: true,
  },
  [TX_RESULT_CODES.TX_NO_ACCOUNT]: {
    userMessage: "The source account does not exist on the Stellar network.",
    retryable: false,
  },
  [TX_RESULT_CODES.TX_INSUFFICIENT_FEE]: {
    userMessage: "The transaction fee is too low for the current network conditions. Please increase the fee and retry.",
    retryable: true,
  },
  [TX_RESULT_CODES.TX_TOO_MANY_OPERATIONS]: {
    userMessage: "The transaction contains too many operations. Please split it into smaller batches.",
    retryable: false,
  },
  [TX_RESULT_CODES.TX_INTERNAL_ERROR]: {
    userMessage: "An internal Stellar ledger error occurred. Please try again later.",
    retryable: true,
  },
};

const OP_CODE_MAP: Record<string, CodeEntry> = {
  [OP_RESULT_CODES.OP_BAD_AUTH]: {
    userMessage:
      "An operation could not be authorized. Please check the signing key for this operation.",
    retryable: false,
  },
  [OP_RESULT_CODES.OP_UNDERFUNDED]: {
    userMessage:
      "Insufficient balance to complete the operation. Please add funds and try again.",
    retryable: false,
  },
  [OP_RESULT_CODES.OP_NO_DESTINATION]: {
    userMessage: "The destination account does not exist on the Stellar network.",
    retryable: false,
  },
  [OP_RESULT_CODES.OP_LINE_FULL]: {
    userMessage: "The destination account's trust line is full.",
    retryable: false,
  },
  [OP_RESULT_CODES.OP_NO_TRUST]: {
    userMessage: "The source account does not have a trust line for this asset.",
    retryable: false,
  },
  [OP_RESULT_CODES.OP_NOT_AUTHORIZED]: {
    userMessage: "This operation is not authorized on the account.",
    retryable: false,
  },
  [OP_RESULT_CODES.OP_NO_ACCOUNT]: {
    userMessage: "The account referenced by this operation does not exist.",
    retryable: false,
  },
  [OP_RESULT_CODES.OP_MALFORMED]: {
    userMessage: "One or more operations in the transaction are malformed.",
    retryable: false,
  },
};

const FALLBACK_ENTRY: CodeEntry = {
  userMessage:
    "The transaction failed due to an unrecognized ledger error. Please check your transaction and try again.",
  retryable: false,
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extracts Horizon result codes from a raw error body string or object.
 *
 * Returns `null` when the body is not a valid Horizon error with result codes.
 */
export function parseHorizonErrorBody(raw: unknown): HorizonErrorBody | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  let parsed: unknown = raw;

  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  return parsed as HorizonErrorBody;
}

/**
 * Translates a Horizon `extras.result_codes` block into a structured failure
 * description.
 *
 * Resolution order:
 *  1. Transaction-level code (e.g. `tx_bad_seq`, `tx_bad_auth`)
 *  2. First non-`op_success` operation-level code from `operations[]`
 *  3. Fallback message for unknown codes
 *
 * @param resultCodes - The `extras.result_codes` object from Horizon.
 * @returns A {@link TranslatedHorizonFailure} with a user-facing message.
 */
export function translateHorizonResultCodes(
  resultCodes: HorizonResultCodes,
): TranslatedHorizonFailure {
  const { transaction, operations } = resultCodes;

  // 1. Check transaction-level code first (non-tx_failed codes are primary)
  if (transaction && transaction !== TX_RESULT_CODES.TX_FAILED) {
    const entry = TX_CODE_MAP[transaction] ?? FALLBACK_ENTRY;
    return {
      code: transaction,
      userMessage: entry.userMessage,
      retryable: entry.retryable,
      rawCodes: resultCodes,
    };
  }

  // 2. Inspect operation-level codes when tx_failed wraps them
  if (Array.isArray(operations)) {
    for (const opCode of operations) {
      if (opCode === null || opCode === "op_success") {
        continue;
      }
      const entry = OP_CODE_MAP[opCode] ?? FALLBACK_ENTRY;
      return {
        code: opCode,
        userMessage: entry.userMessage,
        retryable: entry.retryable,
        rawCodes: resultCodes,
      };
    }
  }

  // 3. Fallback: tx_failed with no recognizable op codes, or unknown tx code
  const primaryCode = transaction ?? "unknown";
  const fallback = TX_CODE_MAP[primaryCode] ?? FALLBACK_ENTRY;
  return {
    code: primaryCode,
    userMessage: fallback.userMessage,
    retryable: fallback.retryable,
    rawCodes: resultCodes,
  };
}

/**
 * High-level helper: parse a raw Horizon error body (string or object) and
 * translate any embedded result codes into a user-facing failure description.
 *
 * Returns `null` when the body does not contain a translatable result-codes
 * block (e.g. network errors, non-Horizon JSON, plain text bodies).
 */
export function translateHorizonError(raw: unknown): TranslatedHorizonFailure | null {
  const body = parseHorizonErrorBody(raw);
  if (!body) {
    return null;
  }

  const resultCodes = body.extras?.result_codes;
  if (!resultCodes) {
    return null;
  }

  return translateHorizonResultCodes(resultCodes);
}
