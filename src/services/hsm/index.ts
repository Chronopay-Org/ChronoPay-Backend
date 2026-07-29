/**
 * HSM Adapter module
 *
 * Exports the provider-agnostic interface and both concrete implementations.
 *
 * Usage:
 * ```ts
 * import { AwsKmsAdapter, GcpKmsAdapter, type IHsmAdapter } from './services/hsm/index.js';
 * ```
 */

export type { IHsmAdapter } from "./hsm-adapter.interface.js";
export { AwsKmsAdapter } from "./aws-kms-adapter.js";
export type { AwsKmsAdapterOptions } from "./aws-kms-adapter.js";
export { GcpKmsAdapter } from "./gcp-kms-adapter.js";
export type { GcpKmsAdapterOptions } from "./gcp-kms-adapter.js";
export {
  HsmError,
  type HsmErrorCode,
  type HsmKeyRef,
  type SigningAlgorithm,
  type SignRequest,
  type SignResponse,
  type VerifyRequest,
  type VerifyResponse,
  type RotateRequest,
  type RotateResponse,
} from "./types.js";
