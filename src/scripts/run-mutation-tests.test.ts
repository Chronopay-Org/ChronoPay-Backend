import { describe, expect, test } from "@jest/globals";
import { existsSync } from "node:fs";
import path from "node:path";

describe("Mutation test runner", () => {
  test("exposes the runner script and config", () => {
    expect(existsSync(path.resolve(process.cwd(), "src/scripts/run-mutation-tests.ts"))).toBe(true);
    expect(existsSync(path.resolve(process.cwd(), "stryker.conf.json"))).toBe(true);
  });
});
