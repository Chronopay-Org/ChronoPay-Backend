import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";

describe("InMemorySlotRepository", () => {
  it("lists seeded slots and looks them up by id", () => {
    const repository = new InMemorySlotRepository();

    const slots = repository.list();

    expect(slots).toHaveLength(3);
    expect(repository.findById("slot-100")).toMatchObject({
      id: "slot-100",
      professional: "alice",
    });
    expect(repository.findById("slot-missing")).toBeUndefined();
  });
});
