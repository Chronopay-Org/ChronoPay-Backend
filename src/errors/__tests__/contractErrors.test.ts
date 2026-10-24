/**
 * Focused behavior coverage for src/errors/contractErrors.ts.
 *
 * Validates the public contract of the contract/Horizon error classes
 * (status code, stable error code, operational flag, name, message overrides)
 * and the two pure helpers `mapContractError` / `shouldRetryContractError`,
 * including representative invalid inputs and boundary cases.
 */

import { describe, it, expect } from "@jest/globals";
import { AppError } from "../AppError.js";
import {
  ContractInvalidRequestError,
  ContractExecutionRevertedError,
  ContractRateLimitError,
  ContractTimeoutError,
  ContractProviderUnavailableError,
  HorizonUnavailableError,
  ContractSequenceCollisionError,
  ContractExecutionError,
  mapContractError,
  shouldRetryContractError,
} from "../contractErrors.js";

describe("contract error classes", () => {
  const cases: Array<{
    name: string;
    create: (message?: string) => AppError;
    status: number;
    code: string;
    operational: boolean;
    defaultMessage: string;
  }> = [
    {
      name: "ContractInvalidRequestError",
      create: (m) => new ContractInvalidRequestError(m),
      status: 400,
      code: "CONTRACT_INVALID_REQUEST",
      operational: true,
      defaultMessage: "Invalid contract request",
    },
    {
      name: "ContractExecutionRevertedError",
      create: (m) => new ContractExecutionRevertedError(m),
      status: 422,
      code: "CONTRACT_EXECUTION_REVERTED",
      operational: true,
      defaultMessage: "Contract execution was reverted",
    },
    {
      name: "ContractRateLimitError",
      create: (m) => new ContractRateLimitError(m),
      status: 503,
      code: "CONTRACT_RATE_LIMITED",
      operational: true,
      defaultMessage: "Contract provider rate limited the request",
    },
    {
      name: "ContractTimeoutError",
      create: (m) => new ContractTimeoutError(m),
      status: 504,
      code: "CONTRACT_TIMEOUT",
      operational: true,
      defaultMessage: "Contract provider timed out",
    },
    {
      name: "ContractProviderUnavailableError",
      create: (m) => new ContractProviderUnavailableError(m),
      status: 503,
      code: "CONTRACT_PROVIDER_UNAVAILABLE",
      operational: true,
      defaultMessage: "Contract provider temporarily unavailable",
    },
    {
      name: "HorizonUnavailableError",
      create: (m) => new HorizonUnavailableError(m),
      status: 503,
      code: "HORIZON_UNAVAILABLE",
      operational: true,
      defaultMessage: "All Horizon hosts are unreachable or quarantined",
    },
    {
      name: "ContractSequenceCollisionError",
      create: (m) => new ContractSequenceCollisionError(m),
      status: 409,
      code: "CONTRACT_SEQUENCE_COLLISION",
      operational: true,
      defaultMessage: "Horizon sequence-number collision detected",
    },
    {
      name: "ContractExecutionError",
      create: (m) => new ContractExecutionError(m),
      status: 500,
      code: "CONTRACT_EXECUTION_FAILED",
      operational: false,
      defaultMessage: "Unexpected contract provider error",
    },
  ];

  it.each(cases)(
    "$name exposes its status, code, operational flag and default message",
    ({ create, status, code, operational, defaultMessage, name }) => {
      const error = create();

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(AppError);
      expect(error.name).toBe(name);
      expect(error.statusCode).toBe(status);
      expect(error.code).toBe(code);
      expect(error.isOperational).toBe(operational);
      expect(error.message).toBe(defaultMessage);
      expect(error.timestamp).toEqual(expect.any(String));
      expect(Number.isNaN(Date.parse(error.timestamp))).toBe(false);
    },
  );

  it.each(cases)("$name honours a custom message override", ({ create, name }) => {
    const error = create("custom detail");
    // AppError sets `name` from the concrete constructor, even when the
    // message is overridden — the wire contract is the code, not the text.
    expect(error.name).toBe(name);
    expect(error.message).toBe("custom detail");
  });

  it("serialises to the flat error envelope", () => {
    const error = new ContractRateLimitError("slow down");
    const json = error.toJSON();

    expect(json.success).toBe(false);
    expect(json.code).toBe("CONTRACT_RATE_LIMITED");
    expect(json.message).toBe("slow down");
  });
});

describe("mapContractError", () => {
  const mapped: Array<[string, unknown, new (...args: any[]) => AppError]> = [
    ["execution reverted text", new Error("execution reverted"), ContractExecutionRevertedError],
    ["out of gas text", "out of gas", ContractExecutionRevertedError],
    ["invalid opcode text", "invalid opcode", ContractExecutionRevertedError],
    ["ethers CALL_EXCEPTION code", { code: "CALL_EXCEPTION" }, ContractExecutionRevertedError],
    ["rate limit text", new Error("rate limit exceeded"), ContractRateLimitError],
    ["too many requests text", "too many requests", ContractRateLimitError],
    ["request timeout text", new Error("request timeout"), ContractProviderUnavailableError],
    ["gateway timeout text", "gateway timeout", ContractProviderUnavailableError],
    ["service unavailable text", "service unavailable", ContractProviderUnavailableError],
    ["connection reset text", "connection reset", ContractProviderUnavailableError],
    ["econnreset text", "econnreset", ContractProviderUnavailableError],
    ["etimedout text", "etimedout", ContractProviderUnavailableError],
    ["ethers TIMEOUT code", { code: "TIMEOUT" }, ContractProviderUnavailableError],
    ["ethers NETWORK_ERROR code", { code: "NETWORK_ERROR" }, ContractProviderUnavailableError],
    ["tx_bad_seq text", "tx_bad_seq", ContractSequenceCollisionError],
    ["bad sequence text", "bad sequence", ContractSequenceCollisionError],
    ["invalid address text", "invalid address", ContractInvalidRequestError],
    ["invalid argument text", "invalid argument", ContractInvalidRequestError],
    ["invalid function text", "invalid function", ContractInvalidRequestError],
    ["function not found text", "function not found", ContractInvalidRequestError],
    ["bad function selector text", "bad function selector", ContractInvalidRequestError],
    ["insufficient funds text", "insufficient funds", ContractInvalidRequestError],
    ["nonce text", "nonce too low", ContractInvalidRequestError],
    ["underpriced text", "replacement transaction underpriced", ContractInvalidRequestError],
    ["signer text", "signer is required", ContractInvalidRequestError],
    ["no signer text", "no signer", ContractInvalidRequestError],
  ];

  it.each(mapped)("maps %s to the documented error class", (_label, input, expected) => {
    expect(mapContractError(input)).toBeInstanceOf(expected);
  });

  it("returns an operational 500 for unrecognised inputs", () => {
    const error = mapContractError(new Error("something exploded"));
    expect(error).toBeInstanceOf(ContractExecutionError);
    expect(error.statusCode).toBe(500);
  });

  it("falls back to ContractExecutionError for nullish and primitive inputs", () => {
    for (const input of [undefined, null, 0, false, {}, []]) {
      expect(mapContractError(input)).toBeInstanceOf(ContractExecutionError);
    }
  });

  it("uses a specific message for transaction-parameter failures", () => {
    const error = mapContractError("insufficient funds for gas");
    expect(error).toBeInstanceOf(ContractInvalidRequestError);
    expect(error.message).toBe(
      "Contract transaction failed due to invalid transaction parameters",
    );
  });

  it("uses a specific message for missing-signer failures", () => {
    const error = mapContractError(new Error("no signer configured"));
    expect(error).toBeInstanceOf(ContractInvalidRequestError);
    expect(error.message).toBe("Signer is required for contract transactions");
  });

  it("is case-insensitive on the normalised error text", () => {
    expect(mapContractError(new Error("EXECUTION REVERTED"))).toBeInstanceOf(
      ContractExecutionRevertedError,
    );
    expect(mapContractError(new Error("RATE LIMIT"))).toBeInstanceOf(ContractRateLimitError);
    expect(mapContractError(new Error("INVALID ADDRESS"))).toBeInstanceOf(
      ContractInvalidRequestError,
    );
  });
});

describe("shouldRetryContractError", () => {
  const retryable: Array<[string, unknown]> = [
    ["ethers TIMEOUT code", { code: "TIMEOUT" }],
    ["ethers NETWORK_ERROR code", { code: "NETWORK_ERROR" }],
    ["rate limit text", "rate limit exceeded"],
    ["timeout text", "request timeout"],
    ["timed out text", "the node timed out"],
    ["network text", "network failure"],
    ["gateway timeout text", "gateway timeout"],
    ["service unavailable text", "service unavailable"],
    ["connection reset text", "connection reset by peer"],
    ["econnreset text", "econnreset"],
    ["etimedout text", "etimedout"],
    ["tx_bad_seq text", "tx_bad_seq"],
    ["bad sequence text", "bad sequence"],
    ["502 text", "upstream returned 502"],
    ["503 text", "upstream returned 503"],
    ["504 text", "upstream returned 504"],
    ["500 text", "upstream returned 500"],
  ];

  it.each(retryable)("treats %s as retryable", (_label, input) => {
    expect(shouldRetryContractError(input)).toBe(true);
  });

  const terminal: Array<[string, unknown]> = [
    ["contract revert", new Error("execution reverted")],
    ["invalid request", new Error("invalid address")],
    ["insufficient funds", "insufficient funds"],
    ["nullish", undefined],
    ["null", null],
    ["number", 0],
    ["empty object", {}],
  ];

  it.each(terminal)("treats %s as terminal", (_label, input) => {
    expect(shouldRetryContractError(input)).toBe(false);
  });

  it("ignores non-retryable ethers codes", () => {
    expect(shouldRetryContractError({ code: "CALL_EXCEPTION" })).toBe(false);
  });
});
