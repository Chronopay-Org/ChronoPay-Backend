# Contract Error Mapping

This document describes how ChronoPay maps upstream contract client errors into deterministic API responses.

## Goals

- Provide stable API error codes for downstream clients.
- Keep returned responses safe by sanitizing upstream error details.
- Retry transient contract provider failures automatically.
- Fail fast when upstream failure patterns persist, using a circuit breaker.

## Error mapping table

| Upstream condition | Stable API code | HTTP status | Client message |
|---|---|---|---|
| Contract execution reverted | `CONTRACT_EXECUTION_REVERTED` | `422` | `Contract execution was reverted` |
| Invalid contract request / bad arguments | `CONTRACT_INVALID_REQUEST` | `400` | `Invalid contract request` |
| Invalid transaction parameters | `CONTRACT_INVALID_REQUEST` | `400` | `Contract transaction failed due to invalid transaction parameters` |
| Missing signer | `CONTRACT_INVALID_REQUEST` | `400` | `Signer is required for contract transactions` |
| Provider rate limiting | `CONTRACT_RATE_LIMITED` | `503` | `Contract provider rate limited the request` |
| Provider timeout or network failure | `CONTRACT_PROVIDER_UNAVAILABLE` | `503` | `Contract provider temporarily unavailable` |
| Unexpected provider failure | `CONTRACT_EXECUTION_FAILED` | `500` | `Unexpected contract provider error` |

## Retry and circuit breaker behavior

The `ContractService` applies the existing retry policy for transient provider failures such as rate limits, timeouts, and temporary network issues.

If multiple provider failures happen in a row, a simple circuit breaker opens and causes contract requests to fail fast with `503` instead of repeatedly retrying the upstream provider.

This reduces confusing client failures and makes the API behavior more deterministic.

## Security notes

- Upstream error messages are not returned verbatim to clients.
- API responses use stable, sanitized messages and error codes.
- Sensitive implementation details such as raw RPC payloads, provider stack traces, or Ethers.js internal messages are hidden from clients.

## Implementation files

- `src/errors/contractErrors.ts`
- `src/services/contract.service.ts`
- `src/clients/ethers-contract-client.ts`
- `src/middleware/errorHandler.ts`
