import { createSlot } from "../../utils/factories.js";

describe("Factories", () => {
  describe("createSlot", () => {
    it("should create a slot with default values", () => {
      const slot = createSlot();
      expect(slot).toHaveProperty("id");
      expect(slot.professional).toBe("test-pro");
      expect(typeof slot.startTime).toBe("number");
      expect(typeof slot.endTime).toBe("number");
    });

    it("should allow overriding values", () => {
      const slot = createSlot({ professional: "alice", id: 123 });
      expect(slot.professional).toBe("alice");
      expect(slot.id).toBe(123);
    });
  });
});
