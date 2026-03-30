import { jest } from "@jest/globals";

describe("startup environment validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("fails fast during module startup when env config is invalid", async () => {
    process.env.NODE_ENV = "invalid";

    await expect(import("../index.js")).rejects.toThrow(
      "Invalid environment configuration:",
    );
  });

  it("allows startup when env config is valid for test mode", async () => {
    process.env.NODE_ENV = "test";
    process.env.PORT = "4010";

    const module = await import("../index.js");

    expect(module.default).toBeDefined();
  });

  it("starts listening with validated config when startServer is invoked", async () => {
    process.env.NODE_ENV = "test";

    const { startServer } = await import("../index.js");
    const listen = jest.fn((_port: number, callback?: () => void) => {
      callback?.();
      return { close: jest.fn() };
    });
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

    startServer({ listen }, { nodeEnv: "production", port: 4321 });

    expect(listen).toHaveBeenCalledWith(4321, expect.any(Function));
    expect(logSpy).toHaveBeenCalledWith("ChronoPay API listening on http://localhost:4321");

    logSpy.mockRestore();
  });
});
