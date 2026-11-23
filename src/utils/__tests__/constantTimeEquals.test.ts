import { jest } from "@jest/globals";
import * as crypto from "node:crypto";
import { constantTimeEquals } from "../constantTimeEquals.js";

describe("constantTimeEquals", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEquals("secret", "secret")).toBe(true);
  });

  it("returns false for different lengths and same length mismatches", () => {
    expect(constantTimeEquals("short", "longer-secret")).toBe(false);
    expect(constantTimeEquals("secret-a", "secret-b")).toBe(false);
  });

  it("uses crypto.timingSafeEqual", () => {
    const spy = jest.spyOn(crypto, "timingSafeEqual");
    expect(constantTimeEquals("secret", "secret")).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
