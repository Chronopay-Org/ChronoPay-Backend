/**
 * AwsKmsAdapter tests
 *
 * - Exercises the full IHsmAdapter contract via the shared suite
 * - Adds AWS-specific unit tests for error classification, retry logic,
 *   and RotateKeyOnDemandCommand behaviour
 */

import { describe, it, expect, jest } from "@jest/globals";
import {
  KMSClient,
  NotFoundException,
  DisabledException,
  InvalidKeyUsageException,
  KMSInvalidSignatureException,
  KMSServiceException,
  SigningAlgorithmSpec,
} from "@aws-sdk/client-kms";
import { AwsKmsAdapter, AccessDeniedException } from "../aws-kms-adapter.js";
import { HsmError, type SigningAlgorithm } from "../types.js";
import { runHsmAdapterContractTests } from "./hsm-adapter.contract.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KEY_ID = "arn:aws:kms:us-east-1:123456789012:key/test-key-id";
const TEST_MSG = new Uint8Array([1, 2, 3]);
const TEST_SIG = new Uint8Array([10, 20, 30]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any, unused-imports/no-unused-vars, @typescript-eslint/no-var-requires
const ALGORITHM: SigningAlgorithm = "ECDSA_SHA_256";

/** Build a mock KMSClient whose `send` resolves/rejects as specified. */
function makeMockClient(
  sendImpl: (command: unknown) => Promise<unknown>,
): KMSClient {
  const client = new KMSClient({ region: "us-east-1" });
  jest.spyOn(client, "send").mockImplementation(sendImpl as Parameters<typeof jest.spyOn>[1]);
  return client;
}

function makeKmsException(
  name: string,
  statusCode: number,
  message = "KMS error",
): KMSServiceException {
  const err = new KMSServiceException({ name, $fault: "client", $metadata: { httpStatusCode: statusCode }, message });
  Object.defineProperty(err, "name", { value: name });
  return err;
}

// ---------------------------------------------------------------------------
// Contract suite wiring
// ---------------------------------------------------------------------------

runHsmAdapterContractTests("AwsKmsAdapter", {
  makeHappyAdapter(opts = {}) {
    const sig = opts.signature ?? TEST_SIG;
    const kv = opts.keyVersion ?? KEY_ID;
    const newKv = opts.newKeyVersion ?? KEY_ID;

    const client = makeMockClient(async (cmd: unknown) => {
      const cmdName = (cmd as { constructor: { name: string } }).constructor.name;
      if (cmdName === "SignCommand") {
        return { Signature: sig, KeyId: kv, SigningAlgorithm: SigningAlgorithmSpec.ECDSA_SHA_256 };
      }
      if (cmdName === "VerifyCommand") {
        return { SignatureValid: true, KeyId: kv };
      }
      if (cmdName === "DescribeKeyCommand") {
        return { KeyMetadata: { KeyId: kv } };
      }
      if (cmdName === "RotateKeyOnDemandCommand") {
        return { KeyId: newKv };
      }
      return {};
    });

    return new AwsKmsAdapter({ clientFactory: () => client });
  },

  makeErrorAdapter(code: string) {
    const client = makeMockClient(async () => {
      const hsmErr = new HsmError(`Simulated ${code}`, code as HsmError["code"]);
      throw hsmErr;
    });
    return new AwsKmsAdapter({ clientFactory: () => client });
  },

  makeFailoverAdapter() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, unused-imports/no-unused-vars, @typescript-eslint/no-var-requires
    let callCount = 0;
    // First client (first region) throws PROVIDER_ERROR; second succeeds
    const failClient = makeMockClient(async () => {
      throw new HsmError("region down", "PROVIDER_ERROR");
    });
    const successClient = makeMockClient(async (cmd: unknown) => {
      const cmdName = (cmd as { constructor: { name: string } }).constructor.name;
      if (cmdName === "SignCommand") {
        return { Signature: TEST_SIG, KeyId: KEY_ID, SigningAlgorithm: SigningAlgorithmSpec.ECDSA_SHA_256 };
      }
      return { Signature: TEST_SIG, KeyId: KEY_ID };
    });

    return new AwsKmsAdapter({
      regions: ["us-east-1", "us-west-2"],
      clientFactory: (region) => {
        callCount++;
        return region === "us-east-1" ? failClient : successClient;
      },
    });
  },

  makeAllRegionsFailAdapter() {
    const client = makeMockClient(async () => {
      throw new HsmError("all down", "PROVIDER_ERROR");
    });
    return new AwsKmsAdapter({
      regions: ["us-east-1", "us-west-2"],
      clientFactory: () => client,
    });
  },

  makeVerifyValidAdapter() {
    const client = makeMockClient(async () => ({
      SignatureValid: true,
      KeyId: KEY_ID,
    }));
    return new AwsKmsAdapter({ clientFactory: () => client });
  },

  makeVerifyInvalidAdapter() {
    const client = makeMockClient(async () => ({
      SignatureValid: false,
      KeyId: KEY_ID,
    }));
    return new AwsKmsAdapter({ clientFactory: () => client });
  },
});

// ---------------------------------------------------------------------------
// AWS-specific unit tests
// ---------------------------------------------------------------------------

describe("AwsKmsAdapter — AWS-specific behaviour", () => {
  describe("sign()", () => {
    it("maps ECDSA_SHA_256 to AWS SigningAlgorithmSpec", async () => {
      let capturedInput: unknown;
      const client = makeMockClient(async (cmd) => {
        capturedInput = (cmd as { input: unknown }).input;
        return { Signature: TEST_SIG, KeyId: KEY_ID, SigningAlgorithm: SigningAlgorithmSpec.ECDSA_SHA_256 };
      });

      const adapter = new AwsKmsAdapter({ clientFactory: () => client });
      await adapter.sign({ key: { keyId: KEY_ID }, message: TEST_MSG, algorithm: "ECDSA_SHA_256" });

      expect((capturedInput as { SigningAlgorithm: string }).SigningAlgorithm).toBe("ECDSA_SHA_256");
    });

    it("passes RAW MessageType to KMS", async () => {
      let capturedInput: unknown;
      const client = makeMockClient(async (cmd) => {
        capturedInput = (cmd as { input: unknown }).input;
        return { Signature: TEST_SIG, KeyId: KEY_ID };
      });

      const adapter = new AwsKmsAdapter({ clientFactory: () => client });
      await adapter.sign({ key: { keyId: KEY_ID }, message: TEST_MSG, algorithm: "ECDSA_SHA_256" });

      expect((capturedInput as { MessageType: string }).MessageType).toBe("RAW");
    });

    it("classifies NotFoundException as KEY_NOT_FOUND", async () => {
      const client = makeMockClient(async () => {
        throw new NotFoundException({ message: "key not found", $metadata: {} });
      });
      const adapter = new AwsKmsAdapter({ clientFactory: () => client });

      await expect(
        adapter.sign({ key: { keyId: KEY_ID }, message: TEST_MSG, algorithm: "ECDSA_SHA_256" }),
      ).rejects.toMatchObject({ code: "KEY_NOT_FOUND" });
    });

    it("classifies AccessDeniedException as PERMISSION_DENIED", async () => {
      const client = makeMockClient(async () => {
        throw new AccessDeniedException({ message: "access denied", $metadata: {} });
      });
      const adapter = new AwsKmsAdapter({ clientFactory: () => client });

      await expect(
        adapter.sign({ key: { keyId: KEY_ID }, message: TEST_MSG, algorithm: "ECDSA_SHA_256" }),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });

    it("classifies DisabledException as KEY_DISABLED", async () => {
      const client = makeMockClient(async () => {
        throw new DisabledException({ message: "key disabled", $metadata: {} });
      });
      const adapter = new AwsKmsAdapter({ clientFactory: () => client });

      await expect(
        adapter.sign({ key: { keyId: KEY_ID }, message: TEST_MSG, algorithm: "ECDSA_SHA_256" }),
      ).rejects.toMatchObject({ code: "KEY_DISABLED" });
    });

    it("classifies InvalidKeyUsageException as ALGORITHM_MISMATCH", async () => {
      const client = makeMockClient(async () => {
        throw new InvalidKeyUsageException({ message: "invalid key usage", $metadata: {} });
      });
      const adapter = new AwsKmsAdapter({ clientFactory: () => client });

      await expect(
        adapter.sign({ key: { keyId: KEY_ID }, message: TEST_MSG, algorithm: "ECDSA_SHA_256" }),
      ).rejects.toMatchObject({ code: "ALGORITHM_MISMATCH" });
    });

    it("classifies generic KMSServiceException as PROVIDER_ERROR", async () => {
      const client = makeMockClient(async () => {
        throw makeKmsException("KMSServiceException", 500);
      });
      const adapter = new AwsKmsAdapter({ clientFactory: () => client });

      await expect(
        adapter.sign({ key: { keyId: KEY_ID }, message: TEST_MSG, algorithm: "ECDSA_SHA_256" }),
      ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    });

    it("wraps non-Error thrown values in HsmError(UNKNOWN)", async () => {
      const client = makeMockClient(async () => {
        throw "string error"; // non-Error throw
      });
      const adapter = new AwsKmsAdapter({ clientFactory: () => client });

      await expect(
        adapter.sign({ key: { keyId: KEY_ID }, message: TEST_MSG, algorithm: "ECDSA_SHA_256" }),
      ).rejects.toMatchObject({ code: "UNKNOWN" });
    });

    it("throws HsmError(PROVIDER_ERROR) when KMS returns no signature bytes", async () => {
      const client = makeMockClient(async () => ({
        Signature: undefined,
        KeyId: KEY_ID,
      }));
      const adapter = new AwsKmsAdapter({ clientFactory: () => client });

      await expect(
        adapter.sign({ key: { keyId: KEY_ID }, message: TEST_MSG, algorithm: "ECDSA_SHA_256" }),
      ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    });

    it("retries on 429 throttle and eventually succeeds", async () => {
      let calls = 0;
      const client = makeMockClient(async () => {
        calls++;
        if (calls < 3) {
          throw makeKmsException("ThrottlingException", 429, "rate exceeded");
        }
        return { Signature: TEST_SIG, KeyId: KEY_ID };
      });

      // Use zero-delay retry so test runs fast
      const adapter = new AwsKmsAdapter({
        clientFactory: () => client,
        // Override retry delay via a custom RetryPolicy implicitly —
        // we just need to confirm the retry happened
      });

      const res = await adapter.sign({ key: { keyId: KEY_ID }, message: TEST_MSG, algorithm: "ECDSA_SHA_256" });
      expect(res.signature).toBeInstanceOf(Uint8Array);
      expect(calls).toBeGreaterThanOrEqual(2);
    });
  });

  describe("verify()", () => {
    it("returns valid:false (no throw) when KMSInvalidSignatureException is thrown", async () => {
      const client = makeMockClient(async () => {
        throw new KMSInvalidSignatureException({
          message: "signature invalid",
          $metadata: {},
        });
      });
      const adapter = new AwsKmsAdapter({ clientFactory: () => client });

      const res = await adapter.verify({
        key: { keyId: KEY_ID },
        message: TEST_MSG,
        signature: TEST_SIG,
        algorithm: "ECDSA_SHA_256",
      });
      expect(res.valid).toBe(false);
    });

    it("passes signature bytes to AWS VerifyCommand", async () => {
      let capturedInput: unknown;
      const client = makeMockClient(async (cmd) => {
        capturedInput = (cmd as { input: unknown }).input;
        return { SignatureValid: true, KeyId: KEY_ID };
      });

      const adapter = new AwsKmsAdapter({ clientFactory: () => client });
      await adapter.verify({
        key: { keyId: KEY_ID },
        message: TEST_MSG,
        signature: TEST_SIG,
        algorithm: "ECDSA_SHA_256",
      });

      expect((capturedInput as { Signature: Uint8Array }).Signature).toEqual(TEST_SIG);
    });
  });

  describe("rotate()", () => {
    it("calls RotateKeyOnDemandCommand with the correct KeyId", async () => {
      const commandsSent: string[] = [];
      const client = makeMockClient(async (cmd) => {
        const name = (cmd as { constructor: { name: string } }).constructor.name;
        commandsSent.push(name);
        if (name === "DescribeKeyCommand") return { KeyMetadata: { KeyId: KEY_ID } };
        if (name === "RotateKeyOnDemandCommand") return { KeyId: KEY_ID };
        return {};
      });

      const adapter = new AwsKmsAdapter({ clientFactory: () => client });
      const res = await adapter.rotate({ key: { keyId: KEY_ID } });

      expect(commandsSent).toContain("RotateKeyOnDemandCommand");
      expect(res.newKeyVersion).toBe(KEY_ID);
      expect(res.previousKeyVersion).toBe(KEY_ID);
    });

    it("throws HsmError(KEY_NOT_FOUND) when DescribeKey returns NotFoundException", async () => {
      const client = makeMockClient(async () => {
        throw new NotFoundException({ message: "not found", $metadata: {} });
      });
      const adapter = new AwsKmsAdapter({ clientFactory: () => client });

      await expect(adapter.rotate({ key: { keyId: KEY_ID } })).rejects.toMatchObject({
        code: "KEY_NOT_FOUND",
      });
    });
  });

  describe("region failover", () => {
    it("does NOT failover on KEY_NOT_FOUND (non-infrastructure error)", async () => {
      let regionsSeen: string[] = [];
      const adapter = new AwsKmsAdapter({
        regions: ["us-east-1", "us-west-2"],
        clientFactory: (region) => {
          regionsSeen.push(region);
          return makeMockClient(async () => {
            throw new NotFoundException({ message: "not found", $metadata: {} });
          });
        },
      });

      await expect(
        adapter.sign({ key: { keyId: KEY_ID }, message: TEST_MSG, algorithm: "ECDSA_SHA_256" }),
      ).rejects.toMatchObject({ code: "KEY_NOT_FOUND" });

      // Only one region should have been tried
      expect(regionsSeen).toHaveLength(1);
    });

    it("does NOT failover on PERMISSION_DENIED (non-infrastructure error)", async () => {
      let regionsSeen: string[] = [];
      const adapter = new AwsKmsAdapter({
        regions: ["us-east-1", "us-west-2"],
        clientFactory: (region) => {
          regionsSeen.push(region);
          return makeMockClient(async () => {
            throw new AccessDeniedException({ message: "denied", $metadata: {} });
          });
        },
      });

      await expect(
        adapter.sign({ key: { keyId: KEY_ID }, message: TEST_MSG, algorithm: "ECDSA_SHA_256" }),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

      expect(regionsSeen).toHaveLength(1);
    });

    it("fails over to second region on PROVIDER_ERROR", async () => {
      const regionsSeen: string[] = [];
      const adapter = new AwsKmsAdapter({
        regions: ["us-east-1", "eu-west-1"],
        clientFactory: (region) => {
          regionsSeen.push(region);
          if (region === "us-east-1") {
            return makeMockClient(async () => {
              throw new HsmError("endpoint down", "PROVIDER_ERROR");
            });
          }
          return makeMockClient(async () => ({
            Signature: TEST_SIG,
            KeyId: KEY_ID,
          }));
        },
      });

      const res = await adapter.sign({ key: { keyId: KEY_ID }, message: TEST_MSG, algorithm: "ECDSA_SHA_256" });
      expect(res.signature).toEqual(TEST_SIG);
      expect(regionsSeen).toContain("eu-west-1");
    });

    it("throws REGION_UNAVAILABLE when every region fails with PROVIDER_ERROR", async () => {
      const adapter = new AwsKmsAdapter({
        regions: ["us-east-1", "eu-west-1", "ap-southeast-1"],
        clientFactory: () =>
          makeMockClient(async () => {
            throw new HsmError("all down", "PROVIDER_ERROR");
          }),
      });

      await expect(
        adapter.sign({ key: { keyId: KEY_ID }, message: TEST_MSG, algorithm: "ECDSA_SHA_256" }),
      ).rejects.toMatchObject({ code: "REGION_UNAVAILABLE" });
    });
  });
});
