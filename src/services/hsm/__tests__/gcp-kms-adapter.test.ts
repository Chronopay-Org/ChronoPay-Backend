/**
 * GcpKmsAdapter tests
 *
 * - Exercises the full IHsmAdapter contract via the shared suite
 * - Adds GCP-specific unit tests for gRPC error mapping, retries,
 *   location failover, and key version management
 */

import { describe, it, expect, jest } from "@jest/globals";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { GcpKmsAdapter } from "../gcp-kms-adapter.js";
import { HsmError, type SigningAlgorithm } from "../types.js";
import { runHsmAdapterContractTests } from "./hsm-adapter.contract.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KEY_VERSION =
  "projects/my-project/locations/us-east1/keyRings/my-ring/cryptoKeys/my-key/cryptoKeyVersions/1";
const CRYPTO_KEY =
  "projects/my-project/locations/us-east1/keyRings/my-ring/cryptoKeys/my-key";
const TEST_MSG = new Uint8Array([1, 2, 3]);
const TEST_SIG = new Uint8Array([10, 20, 30]);
const ALGORITHM: SigningAlgorithm = "ECDSA_SHA_256";

/** Construct a gRPC-style error object (not a real Error instance — matches gRPC SDK shape). */
function makeGrpcError(code: number, message = "gRPC error"): unknown {
  const err = new Error(message) as Error & { code: number; details: string };
  err.code = code;
  err.details = message;
  return err;
}

/** Build a mock KeyManagementServiceClient. */
function makeMockGcpClient(overrides: {
  asymmetricSign?: (req: unknown) => Promise<unknown>;
  asymmetricVerify?: (req: unknown) => Promise<unknown>;
  createCryptoKeyVersion?: (req: unknown) => Promise<unknown>;
  destroyCryptoKeyVersion?: (req: unknown) => Promise<unknown>;
  getCryptoKey?: (req: unknown) => Promise<unknown>;
}): KeyManagementServiceClient {
  const client = new KeyManagementServiceClient();

  if (overrides.asymmetricSign) {
    jest.spyOn(client, "asymmetricSign").mockImplementation(
      overrides.asymmetricSign as Parameters<typeof jest.spyOn>[1],
    );
  }
  if (overrides.asymmetricVerify) {
    jest.spyOn(client as any, "asymmetricVerify").mockImplementation(
      overrides.asymmetricVerify as Parameters<typeof jest.spyOn>[1],
    );
  }
  if (overrides.createCryptoKeyVersion) {
    jest.spyOn(client, "createCryptoKeyVersion").mockImplementation(
      overrides.createCryptoKeyVersion as Parameters<typeof jest.spyOn>[1],
    );
  }
  if (overrides.destroyCryptoKeyVersion) {
    jest.spyOn(client, "destroyCryptoKeyVersion").mockImplementation(
      overrides.destroyCryptoKeyVersion as Parameters<typeof jest.spyOn>[1],
    );
  }
  if (overrides.getCryptoKey) {
    jest.spyOn(client, "getCryptoKey").mockImplementation(
      overrides.getCryptoKey as Parameters<typeof jest.spyOn>[1],
    );
  }

  return client;
}

// ---------------------------------------------------------------------------
// Contract suite wiring
// ---------------------------------------------------------------------------

runHsmAdapterContractTests("GcpKmsAdapter", {
  makeHappyAdapter(opts = {}) {
    const sig = opts.signature ?? TEST_SIG;
    const kv = opts.keyVersion ?? KEY_VERSION;
    const newKv = opts.newKeyVersion ?? KEY_VERSION + "_new";
    const prevKv = opts.previousKeyVersion ?? KEY_VERSION;

    const client = makeMockGcpClient({
      asymmetricSign: async () => [{ signature: sig, name: kv }],
      asymmetricVerify: async () => [{ success: true, name: kv }],
      getCryptoKey: async () => [{ primary: { name: prevKv } }],
      createCryptoKeyVersion: async () => [{ name: newKv }],
      destroyCryptoKeyVersion: async () => [{}],
    });

    return new GcpKmsAdapter({ clientFactory: () => client });
  },

  makeErrorAdapter(code: string) {
    const client = makeMockGcpClient({
      asymmetricSign: async () => {
        throw new HsmError(`Simulated ${code}`, code as HsmError["code"]);
      },
      asymmetricVerify: async () => {
        throw new HsmError(`Simulated ${code}`, code as HsmError["code"]);
      },
      getCryptoKey: async () => {
        throw new HsmError(`Simulated ${code}`, code as HsmError["code"]);
      },
      createCryptoKeyVersion: async () => {
        throw new HsmError(`Simulated ${code}`, code as HsmError["code"]);
      },
    });
    return new GcpKmsAdapter({ clientFactory: () => client });
  },

  makeFailoverAdapter() {
    let callCount = 0;
    return new GcpKmsAdapter({
      locations: ["us-east1", "us-central1"],
      clientFactory: () => {
        callCount++;
        if (callCount === 1) {
          return makeMockGcpClient({
            asymmetricSign: async () => {
              throw new HsmError("location down", "PROVIDER_ERROR");
            },
          });
        }
        return makeMockGcpClient({
          asymmetricSign: async () => [{ signature: TEST_SIG, name: KEY_VERSION }],
        });
      },
    });
  },

  makeAllRegionsFailAdapter() {
    return new GcpKmsAdapter({
      locations: ["us-east1", "us-central1"],
      clientFactory: () =>
        makeMockGcpClient({
          asymmetricSign: async () => {
            throw new HsmError("down", "PROVIDER_ERROR");
          },
        }),
    });
  },

  makeVerifyValidAdapter() {
    const client = makeMockGcpClient({
      asymmetricVerify: async () => [{ success: true, name: KEY_VERSION }],
    });
    return new GcpKmsAdapter({ clientFactory: () => client });
  },

  makeVerifyInvalidAdapter() {
    const client = makeMockGcpClient({
      asymmetricVerify: async () => [{ success: false, name: KEY_VERSION }],
    });
    return new GcpKmsAdapter({ clientFactory: () => client });
  },
});

// ---------------------------------------------------------------------------
// GCP-specific unit tests
// ---------------------------------------------------------------------------

describe("GcpKmsAdapter — GCP-specific behaviour", () => {
  describe("sign()", () => {
    it("passes message bytes to asymmetricSign", async () => {
      let capturedReq: unknown;
      const client = makeMockGcpClient({
        asymmetricSign: async (req) => {
          capturedReq = req;
          return [{ signature: TEST_SIG, name: KEY_VERSION }];
        },
      });

      const adapter = new GcpKmsAdapter({ clientFactory: () => client });
      await adapter.sign({ key: { keyId: KEY_VERSION }, message: TEST_MSG, algorithm: ALGORITHM });

      expect((capturedReq as { data: Uint8Array }).data).toEqual(TEST_MSG);
    });

    it("classifies gRPC NOT_FOUND (code 5) as KEY_NOT_FOUND", async () => {
      const client = makeMockGcpClient({
        asymmetricSign: async () => { throw makeGrpcError(5, "key not found"); },
      });
      const adapter = new GcpKmsAdapter({ clientFactory: () => client });

      await expect(
        adapter.sign({ key: { keyId: KEY_VERSION }, message: TEST_MSG, algorithm: ALGORITHM }),
      ).rejects.toMatchObject({ code: "KEY_NOT_FOUND" });
    });

    it("classifies gRPC PERMISSION_DENIED (code 7) as PERMISSION_DENIED", async () => {
      const client = makeMockGcpClient({
        asymmetricSign: async () => { throw makeGrpcError(7, "permission denied"); },
      });
      const adapter = new GcpKmsAdapter({ clientFactory: () => client });

      await expect(
        adapter.sign({ key: { keyId: KEY_VERSION }, message: TEST_MSG, algorithm: ALGORITHM }),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });

    it("classifies gRPC UNAUTHENTICATED (code 16) as PERMISSION_DENIED", async () => {
      const client = makeMockGcpClient({
        asymmetricSign: async () => { throw makeGrpcError(16, "unauthenticated"); },
      });
      const adapter = new GcpKmsAdapter({ clientFactory: () => client });

      await expect(
        adapter.sign({ key: { keyId: KEY_VERSION }, message: TEST_MSG, algorithm: ALGORITHM }),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });

    it("classifies gRPC FAILED_PRECONDITION (code 9) as KEY_DISABLED", async () => {
      const client = makeMockGcpClient({
        asymmetricSign: async () => { throw makeGrpcError(9, "key disabled"); },
      });
      const adapter = new GcpKmsAdapter({ clientFactory: () => client });

      await expect(
        adapter.sign({ key: { keyId: KEY_VERSION }, message: TEST_MSG, algorithm: ALGORITHM }),
      ).rejects.toMatchObject({ code: "KEY_DISABLED" });
    });

    it("classifies gRPC INVALID_ARGUMENT with 'algorithm' message as ALGORITHM_MISMATCH", async () => {
      const client = makeMockGcpClient({
        asymmetricSign: async () => { throw makeGrpcError(3, "algorithm not supported"); },
      });
      const adapter = new GcpKmsAdapter({ clientFactory: () => client });

      await expect(
        adapter.sign({ key: { keyId: KEY_VERSION }, message: TEST_MSG, algorithm: ALGORITHM }),
      ).rejects.toMatchObject({ code: "ALGORITHM_MISMATCH" });
    });

    it("classifies gRPC INVALID_ARGUMENT with 'disabled' message as KEY_DISABLED", async () => {
      const client = makeMockGcpClient({
        asymmetricSign: async () => { throw makeGrpcError(3, "key version is disabled"); },
      });
      const adapter = new GcpKmsAdapter({ clientFactory: () => client });

      await expect(
        adapter.sign({ key: { keyId: KEY_VERSION }, message: TEST_MSG, algorithm: ALGORITHM }),
      ).rejects.toMatchObject({ code: "KEY_DISABLED" });
    });

    it("throws PROVIDER_ERROR when signature bytes are absent", async () => {
      const client = makeMockGcpClient({
        asymmetricSign: async () => [{ signature: undefined, name: KEY_VERSION }],
      });
      const adapter = new GcpKmsAdapter({ clientFactory: () => client });

      await expect(
        adapter.sign({ key: { keyId: KEY_VERSION }, message: TEST_MSG, algorithm: ALGORITHM }),
      ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    });

    it("retries on gRPC UNAVAILABLE (code 14)", async () => {
      let calls = 0;
      const client = makeMockGcpClient({
        asymmetricSign: async () => {
          calls++;
          if (calls < 3) throw makeGrpcError(14, "service unavailable");
          return [{ signature: TEST_SIG, name: KEY_VERSION }];
        },
      });

      const adapter = new GcpKmsAdapter({ clientFactory: () => client });
      const res = await adapter.sign({ key: { keyId: KEY_VERSION }, message: TEST_MSG, algorithm: ALGORITHM });
      expect(res.signature).toEqual(TEST_SIG);
      expect(calls).toBeGreaterThanOrEqual(2);
    });

    it("retries on gRPC RESOURCE_EXHAUSTED (code 8 — quota)", async () => {
      let calls = 0;
      const client = makeMockGcpClient({
        asymmetricSign: async () => {
          calls++;
          if (calls < 2) throw makeGrpcError(8, "quota exceeded");
          return [{ signature: TEST_SIG, name: KEY_VERSION }];
        },
      });

      const adapter = new GcpKmsAdapter({ clientFactory: () => client });
      const res = await adapter.sign({ key: { keyId: KEY_VERSION }, message: TEST_MSG, algorithm: ALGORITHM });
      expect(res.signature).toEqual(TEST_SIG);
    });
  });

  describe("verify()", () => {
    it("passes signature and message to asymmetricVerify", async () => {
      let capturedReq: unknown;
      const client = makeMockGcpClient({
        asymmetricVerify: async (req) => {
          capturedReq = req;
          return [{ success: true, name: KEY_VERSION }];
        },
      });

      const adapter = new GcpKmsAdapter({ clientFactory: () => client });
      await adapter.verify({
        key: { keyId: KEY_VERSION },
        message: TEST_MSG,
        signature: TEST_SIG,
        algorithm: ALGORITHM,
      });

      expect((capturedReq as { signature: Uint8Array }).signature).toEqual(TEST_SIG);
      expect((capturedReq as { data: Uint8Array }).data).toEqual(TEST_MSG);
    });

    it("returns valid:false (no throw) on gRPC INVALID_ARGUMENT for signature", async () => {
      const client = makeMockGcpClient({
        asymmetricVerify: async () => { throw makeGrpcError(3, "signature invalid"); },
      });
      const adapter = new GcpKmsAdapter({ clientFactory: () => client });

      const res = await adapter.verify({
        key: { keyId: KEY_VERSION },
        message: TEST_MSG,
        signature: TEST_SIG,
        algorithm: ALGORITHM,
      });
      expect(res.valid).toBe(false);
    });
  });

  describe("rotate()", () => {
    it("creates a new CryptoKeyVersion and destroys the old one", async () => {
      const destroyCalls: unknown[] = [];
      const newVersionName =
        "projects/my-project/locations/us-east1/keyRings/my-ring/cryptoKeys/my-key/cryptoKeyVersions/2";

      const client = makeMockGcpClient({
        getCryptoKey: async () => [{ primary: { name: KEY_VERSION } }],
        createCryptoKeyVersion: async () => [{ name: newVersionName }],
        destroyCryptoKeyVersion: async (req) => {
          destroyCalls.push(req);
          return [{}];
        },
      });

      const adapter = new GcpKmsAdapter({ clientFactory: () => client });
      const res = await adapter.rotate({ key: { keyId: CRYPTO_KEY } });

      expect(res.newKeyVersion).toBe(newVersionName);
      expect(res.previousKeyVersion).toBe(KEY_VERSION);
      expect(destroyCalls).toHaveLength(1);
    });

    it("uses the keyId directly as previousKeyVersion if it contains /cryptoKeyVersions/", async () => {
      const newVersionName = KEY_VERSION.replace(/\/1$/, "/2");
      const client = makeMockGcpClient({
        createCryptoKeyVersion: async () => [{ name: newVersionName }],
        destroyCryptoKeyVersion: async () => [{}],
        getCryptoKey: async () => [{ primary: { name: KEY_VERSION } }],
      });

      const adapter = new GcpKmsAdapter({ clientFactory: () => client });
      const res = await adapter.rotate({ key: { keyId: KEY_VERSION } });

      expect(res.previousKeyVersion).toBe(KEY_VERSION);
    });

    it("continues rotation even if destroyCryptoKeyVersion fails (non-fatal)", async () => {
      const newVersionName = KEY_VERSION.replace("/1", "/2");
      const client = makeMockGcpClient({
        getCryptoKey: async () => [{ primary: { name: KEY_VERSION } }],
        createCryptoKeyVersion: async () => [{ name: newVersionName }],
        destroyCryptoKeyVersion: async () => {
          throw makeGrpcError(14, "service unavailable");
        },
      });

      const adapter = new GcpKmsAdapter({ clientFactory: () => client });
      // Should not throw even when destroy fails
      await expect(adapter.rotate({ key: { keyId: CRYPTO_KEY } })).resolves.toMatchObject({
        newKeyVersion: newVersionName,
      });
    });
  });

  describe("location failover", () => {
    it("rewrites the location segment when failing over", async () => {
      const namesReceived: string[] = [];
      let callCount = 0;

      const adapter = new GcpKmsAdapter({
        locations: ["us-east1", "us-central1"],
        clientFactory: () => {
          callCount++;
          if (callCount === 1) {
            return makeMockGcpClient({
              asymmetricSign: async () => {
                throw new HsmError("location down", "PROVIDER_ERROR");
              },
            });
          }
          return makeMockGcpClient({
            asymmetricSign: async (req) => {
              namesReceived.push((req as { name: string }).name);
              return [{ signature: TEST_SIG, name: (req as { name: string }).name }];
            },
          });
        },
      });

      await adapter.sign({ key: { keyId: KEY_VERSION }, message: TEST_MSG, algorithm: ALGORITHM });

      // The key name used in the second request should have "us-central1"
      expect(namesReceived[0]).toContain("us-central1");
    });

    it("does NOT failover on KEY_NOT_FOUND", async () => {
      let clientCallCount = 0;
      const adapter = new GcpKmsAdapter({
        locations: ["us-east1", "us-central1"],
        clientFactory: () => {
          clientCallCount++;
          return makeMockGcpClient({
            asymmetricSign: async () => { throw makeGrpcError(5, "not found"); },
          });
        },
      });

      await expect(
        adapter.sign({ key: { keyId: KEY_VERSION }, message: TEST_MSG, algorithm: ALGORITHM }),
      ).rejects.toMatchObject({ code: "KEY_NOT_FOUND" });

      expect(clientCallCount).toBe(1);
    });

    it("throws REGION_UNAVAILABLE when all GCP locations fail", async () => {
      const adapter = new GcpKmsAdapter({
        locations: ["us-east1", "us-central1", "europe-west1"],
        clientFactory: () =>
          makeMockGcpClient({
            asymmetricSign: async () => {
              throw new HsmError("down", "PROVIDER_ERROR");
            },
          }),
      });

      await expect(
        adapter.sign({ key: { keyId: KEY_VERSION }, message: TEST_MSG, algorithm: ALGORITHM }),
      ).rejects.toMatchObject({ code: "REGION_UNAVAILABLE" });
    });
  });
});
