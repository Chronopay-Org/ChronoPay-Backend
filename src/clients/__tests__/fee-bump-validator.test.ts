import { jest } from "@jest/globals";
import {
  ENVELOPE_TYPE_FEE_BUMP,
  ENVELOPE_TYPE_TX,
  KEY_TYPE_ED25519,
  getEnvelopeType,
  isFeeBumpEnvelope,
  isNestedFeeBump,
  parseFeeBumpTransactionEnvelope,
  validateFeeBumpTransaction,
  validateNonFeeBumpTransaction,
} from "../fee-bump-validator.js";
import { ContractInvalidRequestError } from "../../errors/contractErrors.js";
import {
  TEST_DEST_KEY,
  TEST_FEE_SOURCE_KEY,
  TEST_INNER_SOURCE_KEY,
  TX_FEE,
  TX_SEQ_NUM,
  buildFeeBumpEnvelope,
  buildNestedFeeBumpEnvelope,
  concatBuffers,
  defaultFeeBumpEnvelope,
  defaultRegularEnvelope,
  hexToBytes,
  int64BE,
  makeGenericOp,
  makeMemoHash,
  makeMemoId,
  makeMemoReturnHash,
  makeMemoText,
  makePaymentOperation,
  makeTestSig,
  makeTimeBounds,
  paddedKey,
  toBase64Xdr,
  uint32BE,
} from "./fee-bump-fixtures.js";

// ─────────────────────────────────────────────────────────────────────────────
// getEnvelopeType()
// ─────────────────────────────────────────────────────────────────────────────

describe("getEnvelopeType()", () => {
  it("returns TX envelope type for a regular Tx envelope", () => {
    expect(getEnvelopeType(defaultRegularEnvelope())).toBe(ENVELOPE_TYPE_TX);
  });

  it("returns FEE_BUMP envelope type for a fee-bump envelope", () => {
    expect(getEnvelopeType(defaultFeeBumpEnvelope())).toBe(ENVELOPE_TYPE_FEE_BUMP);
  });

  it("returns null when XDR decodes to fewer than 4 bytes", () => {
    // base64 of a single byte ""
    expect(getEnvelopeType("")).toBeNull();
  });

  it("returns null for an unparseable raw XDR buffer", () => {
    // Pass a string that decodes to 3 bytes (one short of the 4-byte envelope tag)
    const threeBytesB64 = Buffer.from([0x00, 0x00, 0x00]).toString("base64");
    expect(getEnvelopeType(threeBytesB64)).toBeNull();
  });

  it("returns null when decodeBase64 catches an exception", () => {
    jest.spyOn(Buffer, "from").mockImplementationOnce(() => {
      throw new Error("Decode exception");
    });
    expect(getEnvelopeType("some-string")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isFeeBumpEnvelope()
// ─────────────────────────────────────────────────────────────────────────────

describe("isFeeBumpEnvelope()", () => {
  it("returns true for a fee-bump envelope", () => {
    expect(isFeeBumpEnvelope(defaultFeeBumpEnvelope())).toBe(true);
  });

  it("returns false for a regular Tx envelope", () => {
    expect(isFeeBumpEnvelope(defaultRegularEnvelope())).toBe(false);
  });

  it("returns false for invalid/short XDR", () => {
    expect(isFeeBumpEnvelope("")).toBe(false);
    expect(isFeeBumpEnvelope("a")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isNestedFeeBump()
// ─────────────────────────────────────────────────────────────────────────────

describe("isNestedFeeBump()", () => {
  it("returns true when a fee-bump envelope wraps another fee-bump envelope (fee-bump loop)", () => {
    const nested = buildNestedFeeBumpEnvelope(
      TEST_FEE_SOURCE_KEY,
      BigInt(2000),
      TEST_INNER_SOURCE_KEY,
      BigInt(1500),
      TEST_DEST_KEY,
      TX_FEE,
      TX_SEQ_NUM,
      makePaymentOperation(TEST_DEST_KEY, BigInt(100)),
      [makeTestSig()],
      [makeTestSig()],
      [makeTestSig()],
    );
    expect(isNestedFeeBump(nested)).toBe(true);
  });

  it("returns false for a normal fee-bump envelope wrapping a regular Tx envelope", () => {
    expect(isNestedFeeBump(defaultFeeBumpEnvelope())).toBe(false);
  });

  it("returns false for a regular Tx envelope", () => {
    expect(isNestedFeeBump(defaultRegularEnvelope())).toBe(false);
  });

  it("returns false for a 48-byte buffer (just below the inner-envelope-marker threshold)", () => {
    // 4 + 4 + 32 + 8 = 48 bytes — the inner-envelope-type field would start at
    // offset 48 but the guard rejects anything shorter than 52 bytes.
    const fortyEightBytes = concatBuffers(
      uint32BE(ENVELOPE_TYPE_FEE_BUMP),
      uint32BE(KEY_TYPE_ED25519),
      hexToBytes(TEST_FEE_SOURCE_KEY),
      int64BE(BigInt(1000)),
    );
    expect(fortyEightBytes.length).toBe(48);
    expect(isNestedFeeBump(toBase64Xdr(Array.from(fortyEightBytes)))).toBe(false);
  });

  it("returns false for a 51-byte buffer (one byte below the 52-byte threshold)", () => {
    // Take the 48-byte envelope header and append three bytes of garbage so the
    // total length is 51 — still strictly below the 52-byte guard but a tighter
    // boundary than the 48-byte case.
    const fiftyOneBytes = concatBuffers(
      uint32BE(ENVELOPE_TYPE_FEE_BUMP),
      uint32BE(KEY_TYPE_ED25519),
      hexToBytes(TEST_FEE_SOURCE_KEY),
      int64BE(BigInt(1000)),
      new Uint8Array([0x00, 0x00, 0x00]), // 3 pad bytes → 48 + 3 = 51
    );
    expect(fiftyOneBytes.length).toBe(51);
    expect(isNestedFeeBump(toBase64Xdr(Array.from(fiftyOneBytes)))).toBe(false);
  });

  it("returns false for unparseable XDR", () => {
    expect(isNestedFeeBump("")).toBe(false);
    expect(isNestedFeeBump("not-valid-base64=")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseFeeBumpTransactionEnvelope()
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFeeBumpTransactionEnvelope()", () => {
  it("parses a valid fee-bump envelope into its structural details (regression for parser byte-accounting)", () => {
    // This test locks in the byte-accounting of parseFeeBumpEnvelope + skipTransactionRaw.
    // It is the strongest signal that the inner-source peek does not desync the inner/outer
    // signature counters. Using 2 sigs on each side rather than 1 so a regression cannot pass
    // by accident if both counts happen to land on the same byte.
    const envelope = defaultFeeBumpEnvelope(
      BigInt(3000),
      [makeTestSig(), makeTestSig()],
      [makeTestSig(), makeTestSig()],
    );
    const details = parseFeeBumpTransactionEnvelope(envelope);

    expect(details).not.toBeNull();
    expect(details!.fee).toBe(BigInt(3000));
    expect(details!.feeSource).toBe(TEST_FEE_SOURCE_KEY);
    expect(details!.innerSource).toBe(TEST_INNER_SOURCE_KEY);
    expect(details!.innerSignatureCount).toBe(2);
    expect(details!.outerSignatureCount).toBe(2);
    expect(details!.feeSource).not.toBe(details!.innerSource);
  });

  it("regression: 3 inner sigs + 2 outer sigs parsed independently", () => {
    const envelope = defaultFeeBumpEnvelope(
      BigInt(1000),
      [makeTestSig(), makeTestSig(), makeTestSig()],
      [makeTestSig(), makeTestSig()],
    );
    const details = parseFeeBumpTransactionEnvelope(envelope);
    expect(details).not.toBeNull();
    expect(details!.innerSignatureCount).toBe(3);
    expect(details!.outerSignatureCount).toBe(2);
  });

  it("returns null for a regular Tx envelope", () => {
    expect(parseFeeBumpTransactionEnvelope(defaultRegularEnvelope())).toBeNull();
  });

  it("returns null for unparseable/short XDR", () => {
    expect(parseFeeBumpTransactionEnvelope("")).toBeNull();
  });

  it("returns null when the feeSource key type is not Ed25519", () => {
    // Build a fee-bump envelope header where feeSourceType != 0 (e.g. 1 = pre-auth)
    const buf = concatBuffers(
      uint32BE(ENVELOPE_TYPE_FEE_BUMP),
      uint32BE(1), // not Ed25519
      hexToBytes(TEST_FEE_SOURCE_KEY),
      int64BE(BigInt(1000)),
      uint32BE(ENVELOPE_TYPE_TX),
    );
    expect(parseFeeBumpTransactionEnvelope(toBase64Xdr(Array.from(buf)))).toBeNull();
  });

  it("returns null for a fee-bump envelope whose inner envelope type is unsupported", () => {
    // Build a valid fee-bump shell but place inner-envelope-type = 2 (not TX nor FEE_BUMP)
    const header = concatBuffers(
      uint32BE(ENVELOPE_TYPE_FEE_BUMP),
      paddedKey(TEST_FEE_SOURCE_KEY),
      int64BE(BigInt(1000)),
    );
    const buf = concatBuffers(header, uint32BE(2)); // invalid inner envelope type
    expect(parseFeeBumpTransactionEnvelope(toBase64Xdr(Array.from(buf)))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateFeeBumpTransaction()
// ─────────────────────────────────────────────────────────────────────────────

describe("validateFeeBumpTransaction()", () => {
  describe("positive paths", () => {
    it("returns undefined for a valid fee-bump envelope (sponsor sigs + inner sigs both present)", () => {
      expect(validateFeeBumpTransaction(defaultFeeBumpEnvelope())).toBeUndefined();
    });

    it("passes when sponsor pays the exact requested fee-bump amount", () => {
      // The "exact bump amount" positive test from the issue: build an envelope
      // where the sponsor's fee = (innerFee * innerOps + bumpPremium) and verify
      // the validator accepts without throwing, while the parsed details show
      // exactly that amount.
      const exactBump = BigInt(7000);
      const envelope = defaultFeeBumpEnvelope(exactBump, [makeTestSig()], [makeTestSig()]);

      const details = parseFeeBumpTransactionEnvelope(envelope);
      expect(details).not.toBeNull();
      expect(details!.fee).toBe(exactBump);
      expect(validateFeeBumpTransaction(envelope)).toBeUndefined();
    });

    it("returns silently when XDR cannot be decoded (graceful no-op)", () => {
      // Bad envelope type is treated as a no-op rather than an error — the validator
      // is invoked by callers that already pre-screen envelopes via
      // HorizonContractClient.isFeeBumpTransaction.
      expect(() => validateFeeBumpTransaction("")).not.toThrow();
      expect(() => validateFeeBumpTransaction("not-a-real-xdr")).not.toThrow();
    });

    it("returns silently for a non-fee-bump envelope (regular Tx)", () => {
      expect(() => validateFeeBumpTransaction(defaultRegularEnvelope())).not.toThrow();
    });
  });

  describe("negative paths — typed errors", () => {
    it("rejects an envelope where the sponsor feeSource equals the innerTx source", () => {
      // Sponsor must NOT be the same as the inner source, otherwise an actor
      // could effectively self-pay-and-self-sign and bypass the fee-bump path.
      const envelope = buildFeeBumpEnvelope(
        TEST_FEE_SOURCE_KEY,
        BigInt(1000),
        TEST_FEE_SOURCE_KEY, // INTENTIONALLY same as sponsor
        TX_FEE,
        TX_SEQ_NUM,
        makePaymentOperation(TEST_DEST_KEY, BigInt(100)),
        [makeTestSig()],
        [makeTestSig()],
      );

      expect(() => validateFeeBumpTransaction(envelope)).toThrow(ContractInvalidRequestError);
      try {
        validateFeeBumpTransaction(envelope);
      } catch (err) {
        expect((err as Error).message).toMatch(/sponsor/i);
        expect((err as Error).message).toMatch(/source/i);
      }
    });

    it("rejects a fee-bump envelope with no inner-tx signatures", () => {
      const envelope = defaultFeeBumpEnvelope(BigInt(1000), [], [makeTestSig()]);

      expect(() => validateFeeBumpTransaction(envelope)).toThrow(ContractInvalidRequestError);
      try {
        validateFeeBumpTransaction(envelope);
      } catch (err) {
        expect((err as Error).message).toMatch(/inner(-tx)?\s*(tx)?\s*sign|signer/i);
      }
    });

    it("rejects a fee-bump envelope with no sponsor (outer) signatures", () => {
      const envelope = defaultFeeBumpEnvelope(BigInt(1000), [makeTestSig()], []);

      expect(() => validateFeeBumpTransaction(envelope)).toThrow(ContractInvalidRequestError);
      try {
        validateFeeBumpTransaction(envelope);
      } catch (err) {
        expect((err as Error).message).toMatch(/sponsor/i);
        expect((err as Error).message).toMatch(/signature/i);
      }
    });

    it("rejects a fee-bump envelope with a zero fee", () => {
      const envelope = defaultFeeBumpEnvelope(BigInt(0));
      expect(() => validateFeeBumpTransaction(envelope)).toThrow(ContractInvalidRequestError);
      try {
        validateFeeBumpTransaction(envelope);
      } catch (err) {
        expect((err as Error).message).toMatch(/fee/i);
      }
    });

    it("rejects a fee-bump envelope with a negative fee", () => {
      const envelope = defaultFeeBumpEnvelope(BigInt(-1));
      expect(() => validateFeeBumpTransaction(envelope)).toThrow(ContractInvalidRequestError);
    });

    it("rejects a fee-bump envelope whose inner envelope type is unsupported", () => {
      const header = concatBuffers(
        uint32BE(ENVELOPE_TYPE_FEE_BUMP),
        paddedKey(TEST_FEE_SOURCE_KEY),
        int64BE(BigInt(1000)),
      );
      const envelope = toBase64Xdr(Array.from(concatBuffers(header, uint32BE(2))));

      expect(() => validateFeeBumpTransaction(envelope)).toThrow(ContractInvalidRequestError);
      try {
        validateFeeBumpTransaction(envelope);
      } catch (err) {
        expect((err as Error).message).toMatch(/invalid/i);
        expect((err as Error).message).toMatch(/envelope/i);
      }
    });

    it("rejects a fee-bump envelope whose structural details cannot be parsed", () => {
      // Build a fee-bump shell followed by a truncated inner envelope source
      // (only the 4-byte key-type marker, no 32-byte key). Forces parseFeeBumpEnvelope
      // to return null and the validator to throw "Invalid envelope structure".
      const buf = concatBuffers(
        uint32BE(ENVELOPE_TYPE_FEE_BUMP),
        paddedKey(TEST_FEE_SOURCE_KEY),
        int64BE(BigInt(1000)),
        uint32BE(ENVELOPE_TYPE_TX),
        uint32BE(KEY_TYPE_ED25519), // key-type only — missing the actual 32 bytes
      );
      const envelope = toBase64Xdr(Array.from(buf));

      expect(() => validateFeeBumpTransaction(envelope)).toThrow(ContractInvalidRequestError);
    });
  });

  describe("returned error typing", () => {
    it("all rejection errors are ContractInvalidRequestError instances (not generic Error)", () => {
      const envelope = defaultFeeBumpEnvelope(BigInt(0));
      try {
        validateFeeBumpTransaction(envelope);
        fail("expected validateFeeBumpTransaction to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ContractInvalidRequestError);
        expect(err).toBeInstanceOf(Error);
      }
    });
  });

  describe("envelope variants affecting inner-tx layout", () => {
    it("accepts a fee-bump whose inner tx carries a memoText (memo type 1)", () => {
      // memoType === 1 is the only memo branch whose XDR layout (varOpaque)
      // matches the validator's parser. Other memo variants (ID, HASH) are
      // structurally fixed-size in real Stellar and are tracked separately as
      // a future parser-hardening task — see Note in the PR description.
      const op = makePaymentOperation(TEST_DEST_KEY, BigInt(50));
      const envelope = buildFeeBumpEnvelope(
        TEST_FEE_SOURCE_KEY,
        BigInt(2000),
        TEST_INNER_SOURCE_KEY,
        TX_FEE,
        TX_SEQ_NUM,
        op,
        [makeTestSig()],
        [makeTestSig()],
        undefined,
        makeMemoText("hello-stellar"),
      );
      expect(validateFeeBumpTransaction(envelope)).toBeUndefined();
      expect(parseFeeBumpTransactionEnvelope(envelope)).not.toBeNull();
    });

    it("accepts a fee-bump whose inner tx has timeBounds plus a memoText", () => {
      // The timeBoundsPresent === 1 branch in skipTransactionRaw must be covered:
      // memoText path consumes 4 (type) + 4 (length) + N (data); timeBounds
      // adds 16 bytes between source/seq and the memo.
      const op = makePaymentOperation(TEST_DEST_KEY, BigInt(50));
      const timeBounds = makeTimeBounds(BigInt(0), BigInt("1700000000"));
      const envelope = buildFeeBumpEnvelope(
        TEST_FEE_SOURCE_KEY,
        BigInt(3500),
        TEST_INNER_SOURCE_KEY,
        TX_FEE,
        TX_SEQ_NUM,
        op,
        [makeTestSig()],
        [makeTestSig()],
        timeBounds,
        makeMemoText("bounded"),
      );
      expect(parseFeeBumpTransactionEnvelope(envelope)).not.toBeNull();
      expect(validateFeeBumpTransaction(envelope)).toBeUndefined();
    });

    it("accepts a fee-bump whose inner tx carries memoId (memo type 2)", () => {
      const op = makePaymentOperation(TEST_DEST_KEY, BigInt(50));
      const envelope = buildFeeBumpEnvelope(
        TEST_FEE_SOURCE_KEY,
        BigInt(2000),
        TEST_INNER_SOURCE_KEY,
        TX_FEE,
        TX_SEQ_NUM,
        op,
        [makeTestSig()],
        [makeTestSig()],
        undefined,
        makeMemoId(BigInt(12345)),
      );
      expect(parseFeeBumpTransactionEnvelope(envelope)).not.toBeNull();
    });

    it("accepts a fee-bump whose inner tx carries memoHash (memo type 3)", () => {
      const op = makePaymentOperation(TEST_DEST_KEY, BigInt(50));
      const hash = "11".repeat(32);
      const envelope = buildFeeBumpEnvelope(
        TEST_FEE_SOURCE_KEY,
        BigInt(2000),
        TEST_INNER_SOURCE_KEY,
        TX_FEE,
        TX_SEQ_NUM,
        op,
        [makeTestSig()],
        [makeTestSig()],
        undefined,
        makeMemoHash(hash),
      );
      expect(parseFeeBumpTransactionEnvelope(envelope)).not.toBeNull();
    });

    it("accepts a fee-bump whose inner tx carries memoReturnHash (memo type 4)", () => {
      const op = makePaymentOperation(TEST_DEST_KEY, BigInt(50));
      const hash = "22".repeat(32);
      const envelope = buildFeeBumpEnvelope(
        TEST_FEE_SOURCE_KEY,
        BigInt(2000),
        TEST_INNER_SOURCE_KEY,
        TX_FEE,
        TX_SEQ_NUM,
        op,
        [makeTestSig()],
        [makeTestSig()],
        undefined,
        makeMemoReturnHash(hash),
      );
      expect(parseFeeBumpTransactionEnvelope(envelope)).not.toBeNull();
    });

    it("parses operations with explicit source account (hasSource !== 0)", () => {
      const op = makeGenericOp(1, new Uint8Array(48), true, TEST_DEST_KEY);
      const envelope = buildFeeBumpEnvelope(
        TEST_FEE_SOURCE_KEY,
        BigInt(2000),
        TEST_INNER_SOURCE_KEY,
        TX_FEE,
        TX_SEQ_NUM,
        op,
        [makeTestSig()],
        [makeTestSig()],
      );
      expect(parseFeeBumpTransactionEnvelope(envelope)).not.toBeNull();
    });

    it("parses operation body types 0 through 21", () => {
      const opSizes: [number, number][] = [
        [0, 44],
        [1, 48],
        [2, 84],
        [3, 60],
        [4, 56],
        [5, 64],
        [6, 25],
        [7, 40],
        [8, 16],
        [9, 29],
        [10, 96],
        [11, 8],
        [12, 56],
        [13, 80],
        [14, 8],
        [15, 4],
        [16, 192],
        [17, 84],
        [18, 8],
        [19, 36],
        [20, 5],
        [21, 4],
      ];

      for (const [opType, size] of opSizes) {
        const body = new Uint8Array(size);
        const op = makeGenericOp(opType, body);
        const envelope = buildFeeBumpEnvelope(
          TEST_FEE_SOURCE_KEY,
          BigInt(2000),
          TEST_INNER_SOURCE_KEY,
          TX_FEE,
          TX_SEQ_NUM,
          op,
          [makeTestSig()],
          [makeTestSig()],
        );
        const parsed = parseFeeBumpTransactionEnvelope(envelope);
        expect(parsed).not.toBeNull();
      }
    });

    it("returns null for unknown operation body type", () => {
      const op = makeGenericOp(99, new Uint8Array(10));
      const envelope = buildFeeBumpEnvelope(
        TEST_FEE_SOURCE_KEY,
        BigInt(2000),
        TEST_INNER_SOURCE_KEY,
        TX_FEE,
        TX_SEQ_NUM,
        op,
        [makeTestSig()],
        [makeTestSig()],
      );
      expect(parseFeeBumpTransactionEnvelope(envelope)).toBeNull();
    });

    it("returns null for truncated memo or op structures in skipTransactionRaw", () => {
      // Truncated memoType === 1 without length
      const buf1 = concatBuffers(
        uint32BE(ENVELOPE_TYPE_FEE_BUMP),
        paddedKey(TEST_FEE_SOURCE_KEY),
        int64BE(BigInt(1000)),
        uint32BE(ENVELOPE_TYPE_TX),
        paddedKey(TEST_INNER_SOURCE_KEY),
        uint32BE(100), // fee
        int64BE(TX_SEQ_NUM), // seq
        uint32BE(0), // timebounds present = false
        uint32BE(1), // memo type = 1, but missing length field
      );
      expect(parseFeeBumpTransactionEnvelope(toBase64Xdr(Array.from(buf1)))).toBeNull();

      // Truncated memoType === 4 without 32 bytes payload
      const buf2 = concatBuffers(
        uint32BE(ENVELOPE_TYPE_FEE_BUMP),
        paddedKey(TEST_FEE_SOURCE_KEY),
        int64BE(BigInt(1000)),
        uint32BE(ENVELOPE_TYPE_TX),
        paddedKey(TEST_INNER_SOURCE_KEY),
        uint32BE(100),
        int64BE(TX_SEQ_NUM),
        uint32BE(0),
        uint32BE(4), // memo type = 4, but missing 32 bytes payload
      );
      expect(parseFeeBumpTransactionEnvelope(toBase64Xdr(Array.from(buf2)))).toBeNull();

      // Truncated hasSource key
      const buf3 = concatBuffers(
        uint32BE(ENVELOPE_TYPE_FEE_BUMP),
        paddedKey(TEST_FEE_SOURCE_KEY),
        int64BE(BigInt(1000)),
        uint32BE(ENVELOPE_TYPE_TX),
        paddedKey(TEST_INNER_SOURCE_KEY),
        uint32BE(100),
        int64BE(TX_SEQ_NUM),
        uint32BE(0),
        uint32BE(0), // memo none
        uint32BE(1), // ops count = 1
        uint32BE(1), // hasSource = 1, but missing source key
      );
      expect(parseFeeBumpTransactionEnvelope(toBase64Xdr(Array.from(buf3)))).toBeNull();
    });

    it("parses inner fee-bump envelope in parseFeeBumpEnvelope", () => {
      const nested = buildNestedFeeBumpEnvelope(
        TEST_FEE_SOURCE_KEY,
        BigInt(2000),
        TEST_INNER_SOURCE_KEY,
        BigInt(1500),
        TEST_DEST_KEY,
        TX_FEE,
        TX_SEQ_NUM,
        makePaymentOperation(TEST_DEST_KEY, BigInt(100)),
        [makeTestSig()],
        [makeTestSig()],
        [makeTestSig()],
      );
      const details = parseFeeBumpTransactionEnvelope(nested);
      expect(details).not.toBeNull();
      expect(details!.fee).toBe(BigInt(2000));
    });

    it("returns null for nested fee-bump with invalid inner envelope type", () => {
      // Build a nested fee-bump envelope where the innermost envelope type is 99 (invalid)
      const outerEnvelopeType = uint32BE(ENVELOPE_TYPE_FEE_BUMP);
      const outerFeeSource = paddedKey(TEST_FEE_SOURCE_KEY);
      const outerFeeAmt = int64BE(BigInt(2000));
      const middleEnvelopeType = uint32BE(ENVELOPE_TYPE_FEE_BUMP);
      const middleFeeSource = paddedKey(TEST_INNER_SOURCE_KEY);
      const middleFeeAmt = int64BE(BigInt(1500));
      const invalidInnerType = uint32BE(99);

      const buf = concatBuffers(
        outerEnvelopeType,
        outerFeeSource,
        outerFeeAmt,
        middleEnvelopeType,
        middleFeeSource,
        middleFeeAmt,
        invalidInnerType,
      );

      expect(parseFeeBumpTransactionEnvelope(toBase64Xdr(Array.from(buf)))).toBeNull();
    });

    it("parses triple-nested fee-bump envelope (recursive skipFeeBumpTransaction)", () => {
      const middleEnvelopeXdr = buildNestedFeeBumpEnvelope(
        TEST_INNER_SOURCE_KEY,
        BigInt(1500),
        TEST_DEST_KEY,
        BigInt(1000),
        TEST_DEST_KEY,
        TX_FEE,
        TX_SEQ_NUM,
        makePaymentOperation(TEST_DEST_KEY, BigInt(100)),
        [makeTestSig()],
        [makeTestSig()],
        [makeTestSig()],
      );
      const middleBuf = Buffer.from(middleEnvelopeXdr, "base64");
      const outerHeader = concatBuffers(
        uint32BE(ENVELOPE_TYPE_FEE_BUMP),
        paddedKey(TEST_FEE_SOURCE_KEY),
        int64BE(BigInt(2000)),
      );
      const outerEnvelope = concatBuffers(outerHeader, middleBuf, uint32BE(1), makeTestSig());

      const details = parseFeeBumpTransactionEnvelope(toBase64Xdr(Array.from(outerEnvelope)));
      expect(details).not.toBeNull();
      expect(details!.fee).toBe(BigInt(2000));
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateNonFeeBumpTransaction()
// ─────────────────────────────────────────────────────────────────────────────

describe("validateNonFeeBumpTransaction()", () => {
  it("returns silently for a regular Tx envelope (non-fee-bump)", () => {
    expect(() => validateNonFeeBumpTransaction(defaultRegularEnvelope())).not.toThrow();
  });

  it("returns silently for unparseable XDR", () => {
    expect(() => validateNonFeeBumpTransaction("")).not.toThrow();
  });

  it("throws when a fee-bump envelope with sponsor signatures reaches the non-fee-bump entry point", () => {
    // validateNonFeeBumpTransaction is the "shield" for code paths that are not
    // fee-bump aware. If a fee-bump envelope accidentally lands there, it must
    // reject rather than silently allow submission.
    expect(() => validateNonFeeBumpTransaction(defaultFeeBumpEnvelope())).toThrow(
      ContractInvalidRequestError,
    );
    try {
      validateNonFeeBumpTransaction(defaultFeeBumpEnvelope());
    } catch (err) {
      expect((err as Error).message).toMatch(/fee-bump/i);
    }
  });
});


