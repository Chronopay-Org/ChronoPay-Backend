import { HorizonHostManager } from "./horizon-host-manager.js";
import { HorizonUnavailableError, ContractRateLimitError, ContractProviderUnavailableError } from "../errors/contractErrors.js";
import { horizonHostHealth, horizonFailoverTotal } from "../metrics.js";

describe("HorizonHostManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    Date.now = jest.fn(() => 1000000000); // stable time
  });

  it("requires at least one URL", () => {
    expect(() => new HorizonHostManager([])).toThrow("HorizonHostManager requires at least one URL");
  });

  it("returns primary host by default", async () => {
    const manager = new HorizonHostManager(["http://primary", "http://fallback"]);
    expect(await manager.getHealthyHost()).toBe("http://primary");
  });

  it("fails over when primary is quarantined", async () => {
    const manager = new HorizonHostManager(["http://primary", "http://fallback"]);
    
    // Simulate errors
    manager.recordError("http://primary", new ContractProviderUnavailableError());
    manager.recordError("http://primary", new ContractProviderUnavailableError());
    manager.recordError("http://primary", new ContractProviderUnavailableError()); // triggers quarantine

    expect(await manager.getHealthyHost()).toBe("http://fallback");
  });

  it("throws HorizonUnavailableError when all hosts are quarantined", async () => {
    const manager = new HorizonHostManager(["http://primary"]);
    
    manager.recordError("http://primary", new ContractProviderUnavailableError());
    manager.recordError("http://primary", new ContractProviderUnavailableError());
    manager.recordError("http://primary", new ContractProviderUnavailableError());

    await expect(manager.getHealthyHost()).rejects.toThrow(HorizonUnavailableError);
  });

  it("does not quarantine on non-retriable errors (400)", async () => {
    const manager = new HorizonHostManager(["http://primary"]);
    
    // Mock a 400 error
    manager.recordError("http://primary", new Error("invalid argument"));
    manager.recordError("http://primary", new Error("invalid argument"));
    manager.recordError("http://primary", new Error("invalid argument"));

    expect(await manager.getHealthyHost()).toBe("http://primary");
  });
});
