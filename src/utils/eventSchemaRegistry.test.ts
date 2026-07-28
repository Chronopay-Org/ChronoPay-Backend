import { compareEventSchemaRegistries, loadEventSchemaRegistry, validateEventSchemaRegistry } from "./eventSchemaRegistry.js";

describe("Event schema registry", () => {
  it("should validate a well-formed registry", () => {
    const registry = loadEventSchemaRegistry();
    expect(registry.events).toBeDefined();
    expect(Object.keys(registry.events).length).toBeGreaterThan(0);
  });

  it("should reject invalid registry structure", () => {
    expect(() => validateEventSchemaRegistry({})).toThrow(/Invalid event schema registry/);
  });

  it("should preserve existing versions and allow additive extension", () => {
    const base = loadEventSchemaRegistry();
    const head = JSON.parse(JSON.stringify(base));
    const errors = compareEventSchemaRegistries(base, head);
    expect(errors).toEqual([]);
  });
});
