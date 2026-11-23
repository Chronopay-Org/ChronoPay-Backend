import { InMemoryReminderRepository } from "../models/reminder.js";
import { scheduleReminders } from "../services/reminderService.js";

describe("scheduleReminders", () => {
  let repository: InMemoryReminderRepository;

  beforeEach(() => {
    repository = new InMemoryReminderRepository();
    repository.reset();
  });

  it("persists future reminders in the repository", async () => {
    const now = Date.now();
    const reminders = await scheduleReminders(42, now + 2 * 60 * 60 * 1000, "UTC", repository);

    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({
      slotId: 42,
      status: "pending",
      attempts: 0,
      triggerAt: now + 60 * 60 * 1000,
    });

    const stored = await repository.findById(reminders[0].id);
    expect(stored).toEqual(reminders[0]);
  });

  it("skips reminders whose trigger time is already in the past", async () => {
    const now = Date.now();
    const reminders = await scheduleReminders(42, now + 30 * 60 * 1000, undefined, repository);

    expect(reminders).toEqual([]);
  });
});
