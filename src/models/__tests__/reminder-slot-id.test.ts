import {
  InMemoryReminderRepository,
  isSameReminderSlot,
  normalizeReminderSlotId,
} from "../reminder.js";

describe("normalizeReminderSlotId", () => {
  it("turns canonical decimal strings into numbers", () => {
    expect(normalizeReminderSlotId("12")).toBe(12);
    expect(normalizeReminderSlotId("0")).toBe(0);
  });

  it("leaves numbers unchanged", () => {
    expect(normalizeReminderSlotId(12)).toBe(12);
  });

  it("keeps non-numeric ids as strings", () => {
    expect(normalizeReminderSlotId("slot-12")).toBe("slot-12");
    expect(normalizeReminderSlotId("bundle-12")).toBe("bundle-12");
    expect(normalizeReminderSlotId("slot-9b2f6c1e-4d7a-4f3b-8a51-0c5e7d2b9a10")).toBe(
      "slot-9b2f6c1e-4d7a-4f3b-8a51-0c5e7d2b9a10",
    );
  });

  it("keeps strings with leading zeros, signs, spaces or decimals as strings", () => {
    for (const id of ["007", "+7", "-7", " 7", "7 ", "7.5", "1e3", ""]) {
      expect(normalizeReminderSlotId(id)).toBe(id);
    }
  });

  it("keeps digit strings beyond the safe integer range as strings", () => {
    const huge = "9007199254740993";
    expect(normalizeReminderSlotId(huge)).toBe(huge);
  });
});

describe("isSameReminderSlot", () => {
  it("treats a number and its decimal string as the same slot", () => {
    expect(isSameReminderSlot(12, "12")).toBe(true);
    expect(isSameReminderSlot("12", "12")).toBe(true);
  });

  it("distinguishes ids that only share their digits", () => {
    expect(isSameReminderSlot("slot-12", "bundle-12")).toBe(false);
    expect(isSameReminderSlot("slot-12", 12)).toBe(false);
    expect(isSameReminderSlot("007", 7)).toBe(false);
  });
});

describe("InMemoryReminderRepository slot ids and findBySlotAndTrigger", () => {
  let repository: InMemoryReminderRepository;

  beforeEach(() => {
    repository = new InMemoryReminderRepository();
    repository.reset();
  });

  it("stores string slot ids verbatim", async () => {
    const reminder = await repository.create({ slotId: "slot-abc", triggerAt: 1000 });
    expect(reminder.slotId).toBe("slot-abc");
  });

  it("normalises digit-only string ids to numbers on create", async () => {
    const reminder = await repository.create({ slotId: "12", triggerAt: 1000 });
    expect(reminder.slotId).toBe(12);
  });

  it("finds a reminder by slot and trigger time", async () => {
    const created = await repository.create({ slotId: "slot-abc", triggerAt: 1000 });
    const found = await repository.findBySlotAndTrigger("slot-abc", 1000);
    expect(found?.id).toBe(created.id);
  });

  it("returns null for a different slot or a different trigger time", async () => {
    await repository.create({ slotId: "slot-abc", triggerAt: 1000 });
    expect(await repository.findBySlotAndTrigger("slot-xyz", 1000)).toBeNull();
    expect(await repository.findBySlotAndTrigger("slot-abc", 1001)).toBeNull();
    expect(await repository.findBySlotAndTrigger("slot-abc", 999)).toBeNull();
  });

  it("matches a numeric slot id given as a number or as its decimal string", async () => {
    await repository.create({ slotId: 12, triggerAt: 1000 });
    expect(await repository.findBySlotAndTrigger(12, 1000)).not.toBeNull();
    expect(await repository.findBySlotAndTrigger("12", 1000)).not.toBeNull();
    expect(await repository.findBySlotAndTrigger("slot-12", 1000)).toBeNull();
  });

  it("finds reminders in every status, so a sent reminder still counts", async () => {
    const created = await repository.create({ slotId: "slot-abc", triggerAt: 1000 });
    await repository.markSent(created.id);
    const found = await repository.findBySlotAndTrigger("slot-abc", 1000);
    expect(found?.status).toBe("sent");

    const failed = await repository.create({ slotId: "slot-def", triggerAt: 2000 });
    await repository.markFailed(failed.id);
    expect((await repository.findBySlotAndTrigger("slot-def", 2000))?.status).toBe("failed");
  });

  it("returns a detached copy", async () => {
    await repository.create({ slotId: "slot-abc", triggerAt: 1000 });
    const found = await repository.findBySlotAndTrigger("slot-abc", 1000);
    found!.status = "failed";
    expect((await repository.findBySlotAndTrigger("slot-abc", 1000))?.status).toBe("pending");
  });
});
