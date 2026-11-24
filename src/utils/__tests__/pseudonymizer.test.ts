import { pseudonymize, isPseudonymized, PSEUDONYM_PREFIX } from "../pseudonymizer";

describe("pseudonymize", () => {
  it("returns empty values unchanged", () => {
    expect(pseudonymize("")).toBe("");
  });

  it("pseudonymizes a random 43-character URL-safe value instead of returning it unchanged", () => {
    const input = "A".repeat(43);
    const out = pseudonymize(input);
    expect(out).not.toBe(input);
    expect(out.startsWith(PSEUDONYM_PREFIX)).toBe(true);
  });

  it("produces a deterministic pseudonym for the same input", () => {
    const input = "alice@example.com";
    expect(pseudonymize(input)).toBe(pseudonymize(input));
  });

  it("is idempotent: pseudonymize(pseudonymize(x)) === pseudonymize(x)", () => {
    const inputs = ["alice@example.com", "A".repeat(43), "opaque-account-id"];
    for (const x of inputs) {
      const once = pseudonymize(x);
      expect(pseudonymize(once)).toBe(once);
    }
  });

  it("does not treat a bare 43-character value as already pseudonymized", () => {
    const bare = "B".repeat(43);
    expect(isPseudonymized(bare)).toBe(false);
    expect(pseudonymize(bare)).not.toBe(bare);
  });
});

describe("isPseudonymized", () => {
  it("recognises values produced by pseudonymize", () => {
    expect(isPseudonymized(pseudonymize("alice@example.com"))).toBe(true);
  });

  it("requires the versioned prefix", () => {
    expect(isPseudonymized("C".repeat(43))).toBe(false);
    expect(isPseudonymized(`${PSEUDONYM_PREFIX}${"C".repeat(43)}`)).toBe(true);
  });

  it("rejects malformed prefixed bodies", () => {
    expect(isPseudonymized(`${PSEUDONYM_PREFIX}short`)).toBe(false);
    expect(isPseudonymized(`${PSEUDONYM_PREFIX}${"!".repeat(43)}`)).toBe(false);
  });
});
