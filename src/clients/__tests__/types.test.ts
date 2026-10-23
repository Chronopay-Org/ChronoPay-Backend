import type {
  Address,
  ContractCallResult,
  ContractInteractionArgs,
} from "../types.js";

describe("client contract types", () => {
  it("treats Address as a string alias", () => {
    const address: Address = "GABC123";

    expect(address).toBe("GABC123");

    // @ts-expect-error Address is represented by a string.
    const invalidAddress: Address = 123;
    expect(invalidAddress).toBe(123);
  });

  it("supports contract interaction arguments and optional transaction settings", () => {
    const interaction: ContractInteractionArgs = {
      address: "GABC123",
      abi: [{ name: "balanceOf" }],
      method: "balanceOf",
      args: ["GUSER456"],
    };

    expect(interaction.options).toBeUndefined();

    interaction.method = "transfer";
    interaction.args = ["GUSER789", 25n];
    interaction.options = { value: 25n, gasLimit: 100_000n };

    expect(interaction).toEqual({
      address: "GABC123",
      abi: [{ name: "balanceOf" }],
      method: "transfer",
      args: ["GUSER789", 25n],
      options: { value: 25n, gasLimit: 100_000n },
    });

    delete interaction.options;
    expect(interaction.options).toBeUndefined();
  });

  it("rejects invalid interaction field types", () => {
    // @ts-expect-error method must be a string.
    const invalidInteraction: ContractInteractionArgs = { address: "GABC123", abi: [], method: 42, args: [] };
    expect(invalidInteraction.method).toBe(42);

    // @ts-expect-error gasLimit must be a bigint.
    const invalidOptions: ContractInteractionArgs["options"] = { gasLimit: 100_000 };
    expect(invalidOptions?.gasLimit).toBe(100_000);
  });

  it("preserves generic result data and allows block/result updates", () => {
    const result: ContractCallResult<{ balance: bigint }> = {
      data: { balance: 10n },
      blockNumber: 100,
    };

    expect(result).toEqual({ data: { balance: 10n }, blockNumber: 100 });

    result.data = { balance: 15n };
    result.blockNumber = 101;
    expect(result).toEqual({ data: { balance: 15n }, blockNumber: 101 });
  });

  it("rejects invalid result field types", () => {
    // @ts-expect-error blockNumber must be a number.
    const invalidResult: ContractCallResult<string> = { data: "ok", blockNumber: "101" };
    expect(invalidResult.blockNumber).toBe("101");
  });
});