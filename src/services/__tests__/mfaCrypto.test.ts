import {
  decryptTotpSecret,
  deriveMasterKey,
  derivePerUserKey,
  encryptTotpSecret,
} from "../mfaCrypto.js";

describe("mfaCrypto", () => {
  const MASTER_KEY_HEX = "a".repeat(64);
  const MASTER_KEY_B64 = Buffer.from("b".repeat(32)).toString("base64");
  const rawSecret = Buffer.from("26f7abd5f2c6e9d1809234", "hex");

  describe("deriveMasterKey", () => {
    it("accepts 64-char hex and returns 32 bytes", () => {
      expect(deriveMasterKey(MASTER_KEY_HEX)).toHaveLength(32);
    });

    it("accepts base64-encoded 32-byte keys", () => {
      const expected = Buffer.from("b".repeat(32));
      expect(deriveMasterKey(MASTER_KEY_B64).equals(expected)).toBe(true);
    });

    it("rejects malformed or wrong-length keys", () => {
      expect(() => deriveMasterKey("zz".repeat(32))).toThrow(/32-byte key/);
      expect(() => deriveMasterKey("ab".repeat(20))).toThrow(/32-byte key/);
      expect(() => deriveMasterKey("")).toThrow(/32-byte key/);
    });
  });

  describe("encrypt/decrypt round trip", () => {
    it("decrypts back to the original secret", () => {
      const material = encryptTotpSecret(rawSecret, { masterKey: MASTER_KEY_HEX });
      expect(decryptTotpSecret(material, { masterKey: MASTER_KEY_HEX }).equals(rawSecret)).toBe(true);
    });

    it("produces unique iv/salt each invocation", () => {
      const a = encryptTotpSecret(rawSecret, { masterKey: MASTER_KEY_HEX });
      const b = encryptTotpSecret(rawSecret, { masterKey: MASTER_KEY_HEX });
      expect(a.iv.equals(b.iv)).toBe(false);
      expect(a.salt.equals(b.salt)).toBe(false);
      expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    });

    it("fails to decrypt when the master key differs", () => {
      const material = encryptTotpSecret(rawSecret, { masterKey: MASTER_KEY_HEX });
      expect(() => decryptTotpSecret(material, { masterKey: "c".repeat(64) })).toThrow();
    });

    it("fails closed on tampered ciphertext", () => {
      const material = encryptTotpSecret(rawSecret, { masterKey: MASTER_KEY_HEX });
      material.ciphertext[0] = material.ciphertext[0] ^ 0xff;
      expect(() => decryptTotpSecret(material, { masterKey: MASTER_KEY_HEX })).toThrow();
    });

    it("fails closed on tampered auth tag", () => {
      const material = encryptTotpSecret(rawSecret, { masterKey: MASTER_KEY_HEX });
      material.authTag[0] = material.authTag[0] ^ 0x01;
      expect(() => decryptTotpSecret(material, { masterKey: MASTER_KEY_HEX })).toThrow();
    });

    it("rejects malformed iv/auth tag/salt lengths", () => {
      const material = encryptTotpSecret(rawSecret, { masterKey: MASTER_KEY_HEX });
      expect(() => decryptTotpSecret({ ...material, iv: Buffer.alloc(8) }, { masterKey: MASTER_KEY_HEX })).toThrow(/iv or auth tag/);
      expect(() => decryptTotpSecret({ ...material, authTag: Buffer.alloc(4) }, { masterKey: MASTER_KEY_HEX })).toThrow(/iv or auth tag/);
      expect(() => decryptTotpSecret({ ...material, salt: Buffer.alloc(4) }, { masterKey: MASTER_KEY_HEX })).toThrow(/KDF salt/);
    });

    it("derivePerUserKey rejects short salts", () => {
      expect(() => derivePerUserKey(deriveMasterKey(MASTER_KEY_HEX), Buffer.alloc(4))).toThrow(/at least 8 bytes/);
    });

    it("derivePerUserKey is deterministic per (key, salt)", () => {
      const master = deriveMasterKey(MASTER_KEY_HEX);
      const salt = Buffer.from("0123456789abcdef", "hex");
      expect(derivePerUserKey(master, salt).equals(derivePerUserKey(master, salt))).toBe(true);
    });
  });
});