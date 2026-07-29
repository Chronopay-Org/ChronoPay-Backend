import { ContractInvalidRequestError } from "../errors/contractErrors.js";

export const ENVELOPE_TYPE_TX = 1;
export const ENVELOPE_TYPE_FEE_BUMP = 4;
export const KEY_TYPE_ED25519 = 0;

function readInt32BE(buf: Buffer, offset: number): number {
  return buf.readInt32BE(offset);
}

function readBigInt64BE(buf: Buffer, offset: number): bigint {
  return buf.readBigInt64BE(offset);
}

function toHex(buf: Buffer, offset: number, length: number): string {
  return buf.subarray(offset, offset + length).toString("hex").toUpperCase();
}

export interface FeeBumpValidationResult {
  isFeeBump: boolean;
  details?: FeeBumpDetails;
}

export interface FeeBumpDetails {
  feeSource: string;
  innerSource: string;
  fee: bigint;
  innerSignatureCount: number;
  outerSignatureCount: number;
}

function decodeBase64(xdr: string): Buffer | null {
  try {
    return Buffer.from(xdr, "base64");
  } catch {
    return null;
  }
}

function readEnvelopeType(buf: Buffer): number | null {
  if (buf.length < 4) return null;
  return readInt32BE(buf, 0);
}

function countRawSignatures(buf: Buffer, offset: number): number {
  if (buf.length < offset + 4) return 0;
  const count = readInt32BE(buf, offset);
  let pos = offset + 4;
  for (let i = 0; i < count; i++) {
    if (buf.length < pos + 4 + 4) return 0;
    pos += 4;
    const sigLen = readInt32BE(buf, pos);
    pos += 4;
    if (buf.length < pos + sigLen) return 0;
    pos += sigLen;
  }
  return count;
}

function skipTransactionRaw(buf: Buffer, offset: number): number | null {
  let pos = offset;
  if (buf.length < pos + 4 + 32 + 4 + 8 + 4) return null;

  pos += 4;
  pos += 32;
  pos += 4;
  pos += 8;

  const timeBoundsPresent = readInt32BE(buf, pos);
  pos += 4;
  if (timeBoundsPresent !== 0) {
    if (buf.length < pos + 16) return null;
    pos += 16;
  }

  if (buf.length < pos + 4 + 4 + 4) return null;
  const memoType = readInt32BE(buf, pos);
  pos += 4;
  if (memoType === 1) {
    if (buf.length < pos + 4) return null;
    const memoLen = readInt32BE(buf, pos);
    pos += 4;
    if (buf.length < pos + memoLen) return null;
    pos += memoLen;
  } else if (memoType === 2) {
    if (buf.length < pos + 8) return null;
    pos += 8;
  } else if (memoType === 3 || memoType === 4) {
    if (buf.length < pos + 32) return null;
    pos += 32;
  }

  if (buf.length < pos + 4) return null;
  const numOps = readInt32BE(buf, pos);
  pos += 4;

  for (let i = 0; i < numOps; i++) {
    if (buf.length < pos + 4) return null;
    const hasSource = readInt32BE(buf, pos);
    pos += 4;
    if (hasSource !== 0) {
      if (buf.length < pos + 4 + 32) return null;
      pos += 4 + 32;
    }

    if (buf.length < pos + 4) return null;
    const opType = readInt32BE(buf, pos);
    pos += 4;

    const bodyLen = estimateOpBodySize(opType);
    if (bodyLen === null) return null;
    if (buf.length < pos + bodyLen) return null;
    pos += bodyLen;
  }

  if (buf.length < pos + 4) return null;
  const _extV = readInt32BE(buf, pos);
  pos += 4;

  return pos;
}

function estimateOpBodySize(bodyType: number): number | null {
  switch (bodyType) {
    case 0: return 4 + 32 + 8;
    case 1: return 4 + 4 + 32 + 8;
    case 2: return 4 + 4 + 4 + 32 + 32 + 8;
    case 3: return 4 + 32 + 8 + 8 + 8;
    case 4: return 4 + 32 + 20;
    case 5: return 4 + 4 + 32 + 8 + 4 + 4 + 4 + 4;
    case 6: return 4 + 4 + 4 + 1 + 4 + 4 + 4;
    case 7: return 4 + 32 + 4;
    case 8: return 4 + 4 + 4 + 4;
    case 9: return 4 + 4 + 4 + 4 + 4 + 1 + 8;
    case 10: return 4 + 4 + 32 + 4 + 4 + 32 + 4 + 4 + 4 + 4 + 4;
    case 11: return 4 + 4;
    case 12: return 4 + 32 + 20;
    case 13: return 4 + 4 + 32 + 32 + 8;
    case 14: return 4 + 4;
    case 15: return 4;
    case 16: return 4 + 4 + 32 + 32 + 32 + 8 + 8 + 32 + 32 + 8;
    case 17: return 4 + 32 + 4 + 4 + 32 + 8;
    case 18: return 4 + 4;
    case 19: return 4 + 32;
    case 20: return 4 + 1;
    case 21: return 4;
    default: return null;
  }
}

function skipFeeBumpTransaction(buf: Buffer, offset: number): number | null {
  if (buf.length < offset + 4 + 32 + 8) return null;
  offset += 4 + 32 + 8;
  if (buf.length < offset + 4) return null;
  const innerType = readInt32BE(buf, offset);
  offset += 4;
  if (innerType === ENVELOPE_TYPE_FEE_BUMP) {
    return skipFeeBumpTransaction(buf, offset);
  } else if (innerType === ENVELOPE_TYPE_TX) {
    return skipTransactionRaw(buf, offset);
  }
  return null;
}

function parseFeeBumpEnvelope(buf: Buffer): FeeBumpDetails | null {
  if (buf.length < 4 + 4 + 32 + 8) return null;

  const envType = readInt32BE(buf, 0);
  if (envType !== ENVELOPE_TYPE_FEE_BUMP) return null;

  const feeSourceType = readInt32BE(buf, 4);
  if (feeSourceType !== KEY_TYPE_ED25519) return null;

  const feeSource = toHex(buf, 8, 32);
  const fee = readBigInt64BE(buf, 40);

  const innerType = readInt32BE(buf, 48);
  let innerSource = "";
  let offset = 52;

  if (innerType === ENVELOPE_TYPE_TX) {
    if (buf.length < offset + 4 + 32) return null;
    // Peek at the inner source key for the FeeBumpDetails payload; let
    // skipTransactionRaw consume the source itself to keep the byte offsets
    // aligned with the inner transaction body.
    innerSource = toHex(buf, offset + 4, 32);
    const innerEnd = skipTransactionRaw(buf, offset);
    if (innerEnd === null) return null;
    offset = innerEnd;
  } else if (innerType === ENVELOPE_TYPE_FEE_BUMP) {
    const skipped = skipFeeBumpTransaction(buf, offset);
    if (skipped === null) return null;
    offset = skipped;
  } else {
    return null;
  }

  const innerSigCount = countRawSignatures(buf, offset);
  offset += 4;
  for (let i = 0; i < innerSigCount; i++) {
    offset += 4;
    const sigLen = readInt32BE(buf, offset);
    offset += 4 + sigLen;
  }

  const outerSigCount = countRawSignatures(buf, offset);

  return {
    feeSource,
    innerSource,
    fee,
    innerSignatureCount: innerSigCount,
    outerSignatureCount: outerSigCount,
  };
}

export function getEnvelopeType(xdrBase64: string): number | null {
  const buf = decodeBase64(xdrBase64);
  if (!buf) return null;
  return readEnvelopeType(buf);
}

export function isFeeBumpEnvelope(xdrBase64: string): boolean {
  const envType = getEnvelopeType(xdrBase64);
  return envType === ENVELOPE_TYPE_FEE_BUMP;
}

export function parseFeeBumpTransactionEnvelope(xdrBase64: string): FeeBumpDetails | null {
  const buf = decodeBase64(xdrBase64);
  if (!buf) return null;
  return parseFeeBumpEnvelope(buf);
}

export function validateFeeBumpTransaction(xdrBase64: string): void {
  const envType = getEnvelopeType(xdrBase64);
  if (envType === null) {
    return;
  }

  if (envType !== ENVELOPE_TYPE_FEE_BUMP) {
    return;
  }

  const details = parseFeeBumpTransactionEnvelope(xdrBase64);
  if (details === null) {
    throw new ContractInvalidRequestError(
      "Invalid fee-bump transaction envelope structure",
    );
  }

  if (details.fee <= BigInt(0)) {
    throw new ContractInvalidRequestError(
      "Fee-bump transaction must have a positive fee amount",
    );
  }

  if (details.outerSignatureCount === 0) {
    throw new ContractInvalidRequestError(
      "Fee-bump transaction must have sponsor signatures",
    );
  }

  if (details.innerSignatureCount === 0) {
    throw new ContractInvalidRequestError(
      "Fee-bump inner transaction must have inner-tx signer signatures",
    );
  }

  if (details.feeSource === details.innerSource) {
    throw new ContractInvalidRequestError(
      "Fee-bump sponsor cannot be the same as inner transaction source account",
    );
  }
}

export function validateNonFeeBumpTransaction(xdrBase64: string): void {
  const envType = getEnvelopeType(xdrBase64);
  if (envType === null) {
    return;
  }

  if (envType === ENVELOPE_TYPE_FEE_BUMP) {
    if (!isFeeBumpEnvelope(xdrBase64)) return;
    const buf = decodeBase64(xdrBase64);
    if (!buf) return;

    const details = parseFeeBumpEnvelope(buf);
    if (details && details.outerSignatureCount > 0) {
      throw new ContractInvalidRequestError(
        "Fee-bump envelopes require explicit fee-bump validation",
      );
    }
  }
}

export function isNestedFeeBump(xdrBase64: string): boolean {
  const buf = decodeBase64(xdrBase64);
  if (!buf) return false;
  if (buf.length < 4) return false;
  const envType = readInt32BE(buf, 0);
  if (envType !== ENVELOPE_TYPE_FEE_BUMP) return false;
  if (buf.length < 52) return false;
  const innerType = readInt32BE(buf, 48);
  return innerType === ENVELOPE_TYPE_FEE_BUMP;
}
