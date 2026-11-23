import { describe, expect, test } from "@jest/globals";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

describe("Pact contract verification", () => {
  test("loads the checkout-session contract fixture", () => {
    const contractPath = path.resolve(process.cwd(), "test/pact/contracts/checkout-session.json");
    expect(existsSync(contractPath)).toBe(true);

    const contract = JSON.parse(readFileSync(contractPath, "utf-8"));
    expect(contract.consumer).toBe("frontend-client");
    expect(contract.provider).toBe("chronopay-backend");
    expect(contract.interactions).toHaveLength(1);
  });
});
