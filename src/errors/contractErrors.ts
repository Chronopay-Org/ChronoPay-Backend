import {
  AppError,
} from "./AppError.js";

const normalizeErrorText = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message.toLowerCase();
  }
  return String(error).toLowerCase();
};

const isEthersErrorCode = (error: unknown, code: string): boolean => {
  return typeof error === "object" && error !== null && "code" in error && (error as any).code === code;
};

export class ContractInvalidRequestError extends AppError {
  constructor(message = "Invalid contract request") {
    super(message, 400, "CONTRACT_INVALID_REQUEST", true);
  }
}

export class ContractExecutionRevertedError extends AppError {
  constructor(message = "Contract execution was reverted") {
    super(message, 422, "CONTRACT_EXECUTION_REVERTED", true);
  }
}

export class ContractRateLimitError extends AppError {
  constructor(message = "Contract provider rate limited the request") {
    super(message, 503, "CONTRACT_RATE_LIMITED", true);
  }
}

export class ContractTimeoutError extends AppError {
  constructor(message = "Contract provider timed out") {
    super(message, 504, "CONTRACT_TIMEOUT", true);
  }
}

export class ContractProviderUnavailableError extends AppError {
  constructor(message = "Contract provider temporarily unavailable") {
    super(message, 503, "CONTRACT_PROVIDER_UNAVAILABLE", true);
  }
}

export class ContractExecutionError extends AppError {
  constructor(message = "Unexpected contract provider error") {
    super(message, 500, "CONTRACT_EXECUTION_FAILED", false);
  }
}

export function shouldRetryContractError(error: unknown): boolean {
  const text = normalizeErrorText(error);

  if (isEthersErrorCode(error, "TIMEOUT") || isEthersErrorCode(error, "NETWORK_ERROR")) {
    return true;
  }

  return (
    text.includes("rate limit") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("network") ||
    text.includes("gateway timeout") ||
    text.includes("service unavailable") ||
    text.includes("connection reset") ||
    text.includes("econnreset") ||
    text.includes("etimedout") ||
    text.includes("502") ||
    text.includes("503") ||
    text.includes("504") ||
    text.includes("500")
  );
}

export function mapContractError(error: unknown): AppError {
  const text = normalizeErrorText(error);

  if (isEthersErrorCode(error, "CALL_EXCEPTION") || text.includes("revert") || text.includes("execution reverted") || text.includes("out of gas") || text.includes("invalid opcode")) {
    return new ContractExecutionRevertedError();
  }

  if (text.includes("rate limit") || text.includes("too many requests")) {
    return new ContractRateLimitError();
  }

  if (text.includes("timeout") || text.includes("timed out") || text.includes("gateway timeout") || text.includes("service unavailable") || text.includes("connection reset") || text.includes("econnreset") || text.includes("etimedout") || isEthersErrorCode(error, "TIMEOUT") || isEthersErrorCode(error, "NETWORK_ERROR")) {
    return new ContractProviderUnavailableError();
  }

  if (text.includes("invalid address") || text.includes("invalid argument") || text.includes("invalid function") || text.includes("function not found") || text.includes("bad function selector")) {
    return new ContractInvalidRequestError();
  }

  if (text.includes("insufficient funds") || text.includes("nonce") || text.includes("replacement transaction underpriced") || text.includes("underpriced")) {
    return new ContractInvalidRequestError("Contract transaction failed due to invalid transaction parameters");
  }

  if (text.includes("signer") || text.includes("no signer")) {
    return new ContractInvalidRequestError("Signer is required for contract transactions");
  }

  return new ContractExecutionError();
}
