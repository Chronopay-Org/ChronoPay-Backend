export function toBase64Xdr(bytes: number[]): string {
  return Buffer.from(new Uint8Array(bytes)).toString("base64");
}

export function concatBuffers(...arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((acc, a) => acc + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

export function int32BE(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = (n >> 24) & 0xff;
  buf[1] = (n >> 16) & 0xff;
  buf[2] = (n >> 8) & 0xff;
  buf[3] = n & 0xff;
  return buf;
}

export function uint32BE(n: number): Uint8Array {
  return int32BE(n);
}

export function int64BE(n: number | bigint): Uint8Array {
  let big = typeof n === "bigint" ? n : BigInt(n);
  const buf = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    buf[i] = Number(big & BigInt(0xff));
    big >>= BigInt(8);
  }
  return buf;
}

export function paddedKey(keyHex: string): Uint8Array {
  const keyType = int32BE(0);
  const key = hexToBytes(keyHex);
  return concatBuffers(keyType, key);
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function varOpaque(data: Uint8Array): Uint8Array {
  return concatBuffers(uint32BE(data.length), data);
}

export function decoratedSignature(sigHint: string, sigBytes: Uint8Array): Uint8Array {
  const hint = hexToBytes(sigHint);
  return concatBuffers(hint, varOpaque(sigBytes));
}

export function makePaymentOperation(destKey: string, amount: bigint): Uint8Array {
  const hasSource = uint32BE(0);
  const opType = uint32BE(1);
  const dest = paddedKey(destKey);
  const assetType = uint32BE(0);
  const amt = int64BE(amount);
  return concatBuffers(hasSource, opType, dest, assetType, amt);
}

export function makeCreateAccountOperation(destKey: string, startingBalance: bigint): Uint8Array {
  const hasSource = uint32BE(0);
  const opType = uint32BE(0);
  const dest = paddedKey(destKey);
  const balance = int64BE(startingBalance);
  return concatBuffers(hasSource, opType, dest, balance);
}

export function makeMemoNone(): Uint8Array {
  return uint32BE(0);
}

export function makeMemoText(text: string): Uint8Array {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  return concatBuffers(uint32BE(1), varOpaque(data));
}

export function makeMemoHash(hashHex: string): Uint8Array {
  return concatBuffers(uint32BE(3), hexToBytes(hashHex));
}

export function makeMemoId(id: bigint): Uint8Array {
  return concatBuffers(uint32BE(2), int64BE(id));
}

export function makeMemoReturnHash(hashHex: string): Uint8Array {
  return concatBuffers(uint32BE(4), hexToBytes(hashHex));
}

export function makeGenericOp(
  opType: number,
  bodyBytes: Uint8Array,
  hasSource = false,
  sourceKey = TEST_INNER_SOURCE_KEY,
): Uint8Array {
  const sourcePart = hasSource ? concatBuffers(uint32BE(1), paddedKey(sourceKey)) : uint32BE(0);
  const typePart = uint32BE(opType);
  return concatBuffers(sourcePart, typePart, bodyBytes);
}

export function makeTimeBounds(minTime: bigint, maxTime: bigint): Uint8Array {
  return concatBuffers(int64BE(minTime), int64BE(maxTime));
}

export function makeTransaction(
  sourceKey: string,
  fee: number,
  seqNum: bigint,
  operations: Uint8Array | Uint8Array[],
  timeBounds?: Uint8Array,
  memo = makeMemoNone(),
): Uint8Array {
  const source = paddedKey(sourceKey);
  const feeField = uint32BE(fee);
  const seq = int64BE(seqNum);
  const timeBoundsPresent = timeBounds ? uint32BE(1) : uint32BE(0);
  const tb = timeBounds || new Uint8Array(0);
  const opsArray = Array.isArray(operations) ? operations : [operations];
  const opsCount = uint32BE(opsArray.length);
  let opsData: Uint8Array = new Uint8Array(0);
  for (const op of opsArray) {
    opsData = concatBuffers(opsData, op);
  }
  const ext = uint32BE(0);
  return concatBuffers(source, feeField, seq, timeBoundsPresent, tb, memo, opsCount, opsData, ext);
}

export function makeTransactionV1Envelope(tx: Uint8Array, signatures: Uint8Array[]): Uint8Array {
  // TS 5.7 narrows the type of `new Uint8Array(0)` to `Uint8Array<ArrayBuffer>`, but
  // `concatBuffers` returns the wider generic `Uint8Array` (i.e. `Uint8Array<ArrayBufferLike>`),
  // so without the explicit `: Uint8Array` annotation the loop reassignment would be
  // rejected with TS2322. Do not tighten back to `new Uint8Array<ArrayBuffer>(0)`.
  let sigData: Uint8Array = new Uint8Array(0);
  for (const sig of signatures) {
    sigData = concatBuffers(sigData, sig);
  }
  return concatBuffers(tx, uint32BE(signatures.length), sigData);
}

export function buildFeeBumpEnvelope(
  feeSourceKey: string,
  fee: bigint,
  innerSourceKey: string,
  innerFee: number,
  innerSeqNum: bigint,
  operations: Uint8Array,
  innerSigs: Uint8Array[],
  outerSigs: Uint8Array[],
  innerTimeBounds?: Uint8Array,
  innerMemo?: Uint8Array,
): string {
  const envelopeType = uint32BE(4);
  const feeSource = paddedKey(feeSourceKey);
  const feeAmount = int64BE(fee);
  const innerEnvelopeType = uint32BE(1);
  const innerTx = makeTransaction(
    innerSourceKey,
    innerFee,
    innerSeqNum,
    operations,
    innerTimeBounds,
    innerMemo,
  );
  const innerEnvelope = makeTransactionV1Envelope(innerTx, innerSigs);
  const outerSigsData = concatBuffers(uint32BE(outerSigs.length), ...outerSigs);
  const feeBumpTx = concatBuffers(feeSource, feeAmount, innerEnvelopeType, innerEnvelope);
  return toBase64Xdr(Array.from(concatBuffers(envelopeType, feeBumpTx, outerSigsData)));
}

export function buildRegularEnvelope(
  sourceKey: string,
  fee: number,
  seqNum: bigint,
  operations: Uint8Array | Uint8Array[],
  signatures: Uint8Array[],
  timeBounds?: Uint8Array,
  memo?: Uint8Array,
): string {
  const envelopeType = uint32BE(1);
  const tx = makeTransaction(sourceKey, fee, seqNum, operations, timeBounds, memo);
  const envelope = makeTransactionV1Envelope(tx, signatures);
  return toBase64Xdr(Array.from(concatBuffers(envelopeType, envelope)));
}

export const MAX_UINT32 = 0xffffffff;
export const MAX_INT64 = BigInt("0x7fffffffffffffff");

export interface ComputeFeeResult {
  totalFee: number;
  perOperationFee: number;
  operationCount: number;
  overflow: boolean;
}

export function computeTransactionFee(
  perOperationFee: number,
  operationCount: number,
): ComputeFeeResult {
  if (!Number.isInteger(perOperationFee) || perOperationFee < 0) {
    throw new Error("perOperationFee must be a non-negative integer");
  }
  if (!Number.isInteger(operationCount) || operationCount < 0) {
    throw new Error("operationCount must be a non-negative integer");
  }
  const totalFee = perOperationFee * operationCount;
  const overflow = totalFee > MAX_UINT32;
  return {
    totalFee: overflow ? MAX_UINT32 : totalFee,
    perOperationFee,
    operationCount,
    overflow,
  };
}

export function decodeTxEnvelopeFeeAndOps(xdrBase64: string): {
  envelopeType: number;
  fee: number;
  operationCount: number;
  sourceAccount: string;
} {
  const parsed = decodeTxEnvelopeInternal(xdrBase64);
  return {
    envelopeType: parsed.envelopeType,
    fee: parsed.fee,
    operationCount: parsed.operationCount,
    sourceAccount: parsed.sourceAccount,
  };
}

export interface DecodedTimeBounds {
  present: boolean;
  minTime: bigint | null;
  maxTime: bigint | null;
}

export interface DecodedTxEnvelope {
  envelopeType: number;
  fee: number;
  operationCount: number;
  sourceAccount: string;
  seqNum: bigint;
  timeBounds: DecodedTimeBounds;
  signatureCount: number;
}

function decodeTxEnvelopeInternal(xdrBase64: string): DecodedTxEnvelope {
  const buf = Buffer.from(xdrBase64, "base64");
  let offset = 0;

  const envelopeType = buf.readUInt32BE(offset);
  offset += 4;

  let txOffsetStart: number;
  let actualEnvelopeType: number;

  if (envelopeType === 4) {
    offset += 4;
    offset += 32;
    offset += 8;
    actualEnvelopeType = buf.readUInt32BE(offset);
    offset += 4;
    txOffsetStart = offset;
  } else {
    actualEnvelopeType = envelopeType;
    txOffsetStart = offset;
  }

  offset = txOffsetStart;
  offset += 4;
  const sourceAccount = buf
    .subarray(offset, offset + 32)
    .toString("hex")
    .toUpperCase();
  offset += 32;
  const fee = buf.readUInt32BE(offset);
  offset += 4;

  const seqNumHi = buf.readUInt32BE(offset);
  const seqNumLo = buf.readUInt32BE(offset + 4);
  const seqNum = (BigInt(seqNumHi) << BigInt(32)) | BigInt(seqNumLo);
  offset += 8;

  const timeBoundsPresent = buf.readUInt32BE(offset);
  offset += 4;
  let timeBounds: DecodedTimeBounds = { present: false, minTime: null, maxTime: null };
  if (timeBoundsPresent === 1) {
    const minHi = buf.readUInt32BE(offset);
    const minLo = buf.readUInt32BE(offset + 4);
    const minTime = (BigInt(minHi) << BigInt(32)) | BigInt(minLo);
    offset += 8;
    const maxHi = buf.readUInt32BE(offset);
    const maxLo = buf.readUInt32BE(offset + 4);
    const maxTime = (BigInt(maxHi) << BigInt(32)) | BigInt(maxLo);
    offset += 8;
    timeBounds = { present: true, minTime, maxTime };
  }

  const memoType = buf.readUInt32BE(offset);
  offset += 4;
  switch (memoType) {
    case 0:
      break;
    case 1: {
      const len = buf.readUInt32BE(offset);
      offset += 4 + len;
      break;
    }
    case 2:
      offset += 8;
      break;
    case 3:
      offset += 32;
      break;
    case 4:
      offset += 32;
      break;
  }

  const operationCount = buf.readUInt32BE(offset);

  let sigCountOffset = buf.length;
  for (let scan = offset; scan < buf.length - 4; scan++) {
    try {
      const potentialOpCount = buf.readUInt32BE(scan);
      if (potentialOpCount <= 100) {
        const afterOps = scan + 4;
        if (afterOps + 4 <= buf.length) {
          const ext = buf.readUInt32BE(afterOps);
          if (ext === 0) {
            const sigCountPos = afterOps + 4;
            if (sigCountPos + 4 <= buf.length) {
              const possibleSigCount = buf.readUInt32BE(sigCountPos);
              if (possibleSigCount <= 20) {
                sigCountOffset = sigCountPos;
                break;
              }
            }
          }
        }
      }
    } catch {
      // ignore scan errors
    }
  }

  let signatureCount = 0;
  try {
    signatureCount = buf.readUInt32BE(sigCountOffset);
  } catch {
    signatureCount = 0;
  }

  return {
    envelopeType: actualEnvelopeType,
    fee,
    operationCount,
    sourceAccount,
    seqNum,
    timeBounds,
    signatureCount,
  };
}

export function decodeTxEnvelopeTimeBounds(xdrBase64: string): DecodedTimeBounds {
  return decodeTxEnvelopeInternal(xdrBase64).timeBounds;
}

export function decodeTxEnvelopeSeqNum(xdrBase64: string): bigint {
  return decodeTxEnvelopeInternal(xdrBase64).seqNum;
}

export function decodeTxEnvelopeSignatureCount(xdrBase64: string): number {
  return decodeTxEnvelopeInternal(xdrBase64).signatureCount;
}

export interface PreAuthSigner {
  signerKey: string;
  weight: number;
}

export const PRE_AUTH_TX_SIGNER_KEY_TYPE = 1;

export function makePreAuthTxSigner(txHashHex: string, weight = 1): Uint8Array {
  const keyType = uint32BE(PRE_AUTH_TX_SIGNER_KEY_TYPE);
  const hash = hexToBytes(txHashHex);
  return concatBuffers(keyType, hash, uint32BE(weight));
}

export interface TimeBoundRefreshResult {
  originalXdr: string;
  refreshedXdr: string;
  originalMaxTime: bigint;
  newMaxTime: bigint;
  signatureCount: number;
  reSigned: boolean;
}

export function isEnvelopeExpired(xdrBase64: string, nowUnixSeconds: bigint): boolean {
  const tb = decodeTxEnvelopeTimeBounds(xdrBase64);
  if (!tb.present || tb.maxTime === null) {
    return false;
  }
  return nowUnixSeconds >= tb.maxTime;
}

export function isEnvelopeNearExpiry(
  xdrBase64: string,
  nowUnixSeconds: bigint,
  windowSeconds: bigint,
): boolean {
  const tb = decodeTxEnvelopeTimeBounds(xdrBase64);
  if (!tb.present || tb.maxTime === null) {
    return false;
  }
  return tb.maxTime - nowUnixSeconds <= windowSeconds;
}

export function extractTxHashFromMemoHash(memoHex: string): string {
  return memoHex.toLowerCase();
}

export function buildNestedFeeBumpEnvelope(
  outerFeeSourceKey: string,
  outerFee: bigint,
  innerFeeSourceKey: string,
  innerFee: bigint,
  innerSourceKey: string,
  innerTxFee: number,
  innerSeqNum: bigint,
  operations: Uint8Array,
  innerSigs: Uint8Array[],
  middleSigs: Uint8Array[],
  outerSigs: Uint8Array[],
): string {
  const innerTx = makeTransaction(innerSourceKey, innerTxFee, innerSeqNum, operations);
  const innerEnvelopeType = uint32BE(1);
  const innerEnvelope = makeTransactionV1Envelope(innerTx, innerSigs);
  const middleEnvelopeType = uint32BE(4);
  const middleFeeSource = paddedKey(innerFeeSourceKey);
  const middleFeeAmt = int64BE(innerFee);
  const middleSigsData = concatBuffers(uint32BE(middleSigs.length), ...middleSigs);
  const middleFeeBumpTx = concatBuffers(
    middleFeeSource,
    middleFeeAmt,
    innerEnvelopeType,
    innerEnvelope,
  );
  const _middleEnvelope = concatBuffers(middleEnvelopeType, middleFeeBumpTx, middleSigsData);

  const outerEnvelopeType = uint32BE(4);
  const outerFeeSource = paddedKey(outerFeeSourceKey);
  const outerFeeAmt = int64BE(outerFee);
  const outerSigsData = concatBuffers(uint32BE(outerSigs.length), ...outerSigs);
  const outerFeeBumpTx = concatBuffers(
    outerFeeSource,
    outerFeeAmt,
    uint32BE(4),
    middleFeeBumpTx,
    middleSigsData,
  );
  return toBase64Xdr(Array.from(concatBuffers(outerEnvelopeType, outerFeeBumpTx, outerSigsData)));
}

export const TEST_FEE_SOURCE_KEY =
  "DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF";
export const TEST_INNER_SOURCE_KEY =
  "CAFEBABECAFEBABECAFEBABECAFEBABECAFEBABECAFEBABECAFEBABECAFEBABE";
export const TEST_DEST_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const TEST_SIG_HINT = "12345678";
export const TEST_SIG_BYTES = new Uint8Array(64).fill(0x42);

export function makeTestSig(): Uint8Array {
  return decoratedSignature(TEST_SIG_HINT, TEST_SIG_BYTES);
}

export const TX_FEE = 100;
export const TX_SEQ_NUM = BigInt("1234567890");

export function defaultFeeBumpEnvelope(
  fee = BigInt("1000"),
  innerSigs: Uint8Array[] = [makeTestSig()],
  outerSigs: Uint8Array[] = [makeTestSig()],
): string {
  const op = makePaymentOperation(TEST_DEST_KEY, BigInt("100"));
  return buildFeeBumpEnvelope(
    TEST_FEE_SOURCE_KEY,
    fee,
    TEST_INNER_SOURCE_KEY,
    TX_FEE,
    TX_SEQ_NUM,
    op,
    innerSigs,
    outerSigs,
  );
}

export function defaultRegularEnvelope(): string {
  const op = makePaymentOperation(TEST_DEST_KEY, BigInt("100"));
  return buildRegularEnvelope(TEST_INNER_SOURCE_KEY, TX_FEE, TX_SEQ_NUM, op, [makeTestSig()]);
}
