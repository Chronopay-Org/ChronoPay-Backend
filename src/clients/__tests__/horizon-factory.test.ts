import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { createHorizonClient } from "../horizon-factory.js";
import { HorizonLedgerFixture } from "../../tests/fixtures/horizonLedger.js";

describe("createHorizonClient()", () => {
  const OLD_ENV = process.env.HORIZON_MODE;

  afterEach(() => {
    if (OLD_ENV === undefined) {
      delete process.env.HORIZON_MODE;
    } else {
      process.env.HORIZON_MODE = OLD_ENV;
    }
  });

  it("returns HorizonLedgerFixture when mode is fixture", () => {
    const client = createHorizonClient("fixture");
    expect(client).toBeInstanceOf(HorizonLedgerFixture);
  });

  it("returns HorizonLedgerFixture when env HORIZON_MODE=fixture", () => {
    process.env.HORIZON_MODE = "fixture";
    const client = createHorizonClient();
    expect(client).toBeInstanceOf(HorizonLedgerFixture);
  });

  it("returns HorizonLedgerFixture for fixture mode overriding live env", () => {
    process.env.HORIZON_MODE = "live";
    const client = createHorizonClient("fixture");
    expect(client).toBeInstanceOf(HorizonLedgerFixture);
  });

  it("fixture client responds to call()", async () => {
    const client = createHorizonClient("fixture") as HorizonLedgerFixture;
    const res = await client.call({ address: "GA", abi: null, method: "getAccount", args: ["GA"] });
    expect(res.data.id).toBe("GA");
  });
});
