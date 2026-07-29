/**
 * HSM adapter contract tests — shared behaviour suite
 *
 * This file defines `runHsmAdapterContractTests`, a function that exercises the
 * `IHsmAdapter` contract using any concrete adapter passed to it. The same
 * suite is executed for both `AwsKmsAdapter` and `GcpKmsAdapter`.
 *
 * Contract obligations tested:
 * ─────────────────────────────
 * 1.  sign returns a non-empty Uint8Array signature
 * 2.  sign echoes the requested algorithm in its response
 * 3.  sign returns a keyVersion string
 * 4.  verify returns valid:true for a signature produced by sign
 * 5.  verify returns valid:false (no throw) for a tampered signature
 * 6.  rotate returns newKeyVersion and previousKeyVersion strings
 * 7.  rotate previousKeyVersion differs from (or equals) newKeyVersion
 *     depending on the provider's versioning scheme
 * 8.  sign throws HsmError(KEY_NOT_FOUND) for an unknown key
 * 9.  sign throws HsmError(PERMISSION_DENIED) when credentials are refused
 * 10. sign throws HsmError(KEY_DISABLED) for a disabled key
 * 11. sign throws HsmError(ALGORITHM_MISMATCH) for an incompatible algorithm
 * 12. verify throws HsmError(KEY_NOT_FOUND) for an unknown key
 * 13. rotate throws HsmError(KEY_NOT_FOUND) for an unknown key
 * 14. Region/location failover: succeeds after first region fails
 * 15. All regions exhausted: throws HsmError(REGION_UNAVAILABLE)
 */

import { describe, it, expect } from "@jest/globals";
import type { IHsmAdapter } from "../hsm-adapter.interface.js";
import { HsmError } from "../types.js";
import type { SigningAlgorithm } from "../types.js";

/** Minimal factory spec consumed by the contract suite. */
export interface AdapterFactory {
  /**
   * Create an adapter whose underlying KMS client reports a valid signing
   * operation, returning `signature` for the given `message`.
   */
  makeHappyAdapter(opts?: {
    signature?: Uint8Array;
    keyVersion?: string;
    newKeyVersion?: string;
    previousKeyVersion?: string;
  }): IHsmAdapter;

  /**
   * Create an adapter that throws `HsmError` with `code` for any operation.
   */
  makeErrorAdapter(code: string): IHsmAdapter;

  /**
   * Create an adapter that fails on the first region/location then succeeds.
   * Used to test region failover.
   */
  makeFailoverAdapter(): IHsmAdapter;

  /**
   * Create an adapter whose every region/location fails.
   * Used to test exhausted failover.
   */
  makeAllRegionsFailAdapter(): IHsmAdapter;

  /**
   * Create an adapter that returns `valid: true` for verify.
   */
  makeVerifyValidAdapter(): IHsmAdapter;

  /**
   * Create an adapter that returns `valid: false` (but does NOT throw)
   * for verify.
   */
  makeVerifyInvalidAdapter(): IHsmAdapter;
}

const TEST_KEY = { keyId: "test-key-id", alias: "test-key" };
const TEST_MESSAGE = new Uint8Array([1, 2, 3, 4, 5]);
const TEST_SIGNATURE = new Uint8Array([10, 20, 30, 40, 50]);
const ALGORITHM: SigningAlgorithm = "ECDSA_SHA_256";

export function runHsmAdapterContractTests(
  adapterName: string,
  factory: AdapterFactory,
): void {
  describe(`${adapterName} — IHsmAdapter contract`, () => {
    // ──────────────────────────────────────────────────────────────────────
    // sign
    // ──────────────────────────────────────────────────────────────────────

    describe("sign()", () => {
      it("returns a non-empty Uint8Array signature", async () => {
        const adapter = factory.makeHappyAdapter({ signature: TEST_SIGNATURE });
        const res = await adapter.sign({ key: TEST_KEY, message: TEST_MESSAGE, algorithm: ALGORITHM });
        expect(res.signature).toBeInstanceOf(Uint8Array);
        expect(res.signature.length).toBeGreaterThan(0);
      });

      it("echoes the requested algorithm in the response", async () => {
        const adapter = factory.makeHappyAdapter();
        const res = await adapter.sign({ key: TEST_KEY, message: TEST_MESSAGE, algorithm: ALGORITHM });
        expect(res.algorithm).toBe(ALGORITHM);
      });

      it("returns a non-empty keyVersion string", async () => {
        const adapter = factory.makeHappyAdapter({ keyVersion: "v1" });
        const res = await adapter.sign({ key: TEST_KEY, message: TEST_MESSAGE, algorithm: ALGORITHM });
        expect(typeof res.keyVersion).toBe("string");
        expect(res.keyVersion.length).toBeGreaterThan(0);
      });

      it("throws HsmError(KEY_NOT_FOUND) for an unknown key", async () => {
        const adapter = factory.makeErrorAdapter("KEY_NOT_FOUND");
        await expect(
          adapter.sign({ key: TEST_KEY, message: TEST_MESSAGE, algorithm: ALGORITHM }),
        ).rejects.toMatchObject({ code: "KEY_NOT_FOUND" });
      });

      it("throws HsmError(PERMISSION_DENIED) when credentials are refused", async () => {
        const adapter = factory.makeErrorAdapter("PERMISSION_DENIED");
        await expect(
          adapter.sign({ key: TEST_KEY, message: TEST_MESSAGE, algorithm: ALGORITHM }),
        ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      });

      it("throws HsmError(KEY_DISABLED) for a disabled key", async () => {
        const adapter = factory.makeErrorAdapter("KEY_DISABLED");
        await expect(
          adapter.sign({ key: TEST_KEY, message: TEST_MESSAGE, algorithm: ALGORITHM }),
        ).rejects.toMatchObject({ code: "KEY_DISABLED" });
      });

      it("throws HsmError(ALGORITHM_MISMATCH) for an incompatible algorithm", async () => {
        const adapter = factory.makeErrorAdapter("ALGORITHM_MISMATCH");
        await expect(
          adapter.sign({ key: TEST_KEY, message: TEST_MESSAGE, algorithm: ALGORITHM }),
        ).rejects.toMatchObject({ code: "ALGORITHM_MISMATCH" });
      });

      it("errors are instances of HsmError", async () => {
        const adapter = factory.makeErrorAdapter("KEY_NOT_FOUND");
        await expect(
          adapter.sign({ key: TEST_KEY, message: TEST_MESSAGE, algorithm: ALGORITHM }),
        ).rejects.toBeInstanceOf(HsmError);
      });
    });

    // ──────────────────────────────────────────────────────────────────────
    // verify
    // ──────────────────────────────────────────────────────────────────────

    describe("verify()", () => {
      it("returns valid:true for a valid signature", async () => {
        const adapter = factory.makeVerifyValidAdapter();
        const res = await adapter.verify({
          key: TEST_KEY,
          message: TEST_MESSAGE,
          signature: TEST_SIGNATURE,
          algorithm: ALGORITHM,
        });
        expect(res.valid).toBe(true);
      });

      it("returns valid:false (does not throw) for an invalid signature", async () => {
        const adapter = factory.makeVerifyInvalidAdapter();
        const res = await adapter.verify({
          key: TEST_KEY,
          message: TEST_MESSAGE,
          signature: TEST_SIGNATURE,
          algorithm: ALGORITHM,
        });
        expect(res.valid).toBe(false);
      });

      it("returns a non-empty keyVersion string", async () => {
        const adapter = factory.makeVerifyValidAdapter();
        const res = await adapter.verify({
          key: TEST_KEY,
          message: TEST_MESSAGE,
          signature: TEST_SIGNATURE,
          algorithm: ALGORITHM,
        });
        expect(typeof res.keyVersion).toBe("string");
        expect(res.keyVersion.length).toBeGreaterThan(0);
      });

      it("throws HsmError(KEY_NOT_FOUND) for an unknown key", async () => {
        const adapter = factory.makeErrorAdapter("KEY_NOT_FOUND");
        await expect(
          adapter.verify({
            key: TEST_KEY,
            message: TEST_MESSAGE,
            signature: TEST_SIGNATURE,
            algorithm: ALGORITHM,
          }),
        ).rejects.toMatchObject({ code: "KEY_NOT_FOUND" });
      });

      it("throws HsmError(PERMISSION_DENIED) when credentials are refused", async () => {
        const adapter = factory.makeErrorAdapter("PERMISSION_DENIED");
        await expect(
          adapter.verify({
            key: TEST_KEY,
            message: TEST_MESSAGE,
            signature: TEST_SIGNATURE,
            algorithm: ALGORITHM,
          }),
        ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      });
    });

    // ──────────────────────────────────────────────────────────────────────
    // rotate
    // ──────────────────────────────────────────────────────────────────────

    describe("rotate()", () => {
      it("returns newKeyVersion and previousKeyVersion strings", async () => {
        const adapter = factory.makeHappyAdapter({
          newKeyVersion: "v2",
          previousKeyVersion: "v1",
        });
        const res = await adapter.rotate({ key: TEST_KEY });
        expect(typeof res.newKeyVersion).toBe("string");
        expect(res.newKeyVersion.length).toBeGreaterThan(0);
        expect(typeof res.previousKeyVersion).toBe("string");
        expect(res.previousKeyVersion.length).toBeGreaterThan(0);
      });

      it("throws HsmError(KEY_NOT_FOUND) for an unknown key", async () => {
        const adapter = factory.makeErrorAdapter("KEY_NOT_FOUND");
        await expect(adapter.rotate({ key: TEST_KEY })).rejects.toMatchObject({
          code: "KEY_NOT_FOUND",
        });
      });

      it("throws HsmError(PERMISSION_DENIED) when credentials are refused", async () => {
        const adapter = factory.makeErrorAdapter("PERMISSION_DENIED");
        await expect(adapter.rotate({ key: TEST_KEY })).rejects.toMatchObject({
          code: "PERMISSION_DENIED",
        });
      });
    });

    // ──────────────────────────────────────────────────────────────────────
    // Region / location failover
    // ──────────────────────────────────────────────────────────────────────

    describe("region/location failover", () => {
      it("succeeds when the first region fails and the second succeeds", async () => {
        const adapter = factory.makeFailoverAdapter();
        // Should not throw — second region handles the request
        const res = await adapter.sign({
          key: TEST_KEY,
          message: TEST_MESSAGE,
          algorithm: ALGORITHM,
        });
        expect(res.signature).toBeInstanceOf(Uint8Array);
      });

      it("throws HsmError(REGION_UNAVAILABLE) when all regions are exhausted", async () => {
        const adapter = factory.makeAllRegionsFailAdapter();
        await expect(
          adapter.sign({ key: TEST_KEY, message: TEST_MESSAGE, algorithm: ALGORITHM }),
        ).rejects.toMatchObject({ code: "REGION_UNAVAILABLE" });
      });
    });
  });
}
