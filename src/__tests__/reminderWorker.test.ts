import { jest } from "@jest/globals";
import { InMemoryReminderRepository } from "../models/reminder.js";
import { processReminders } from "../scheduler/reminderWorker.js";

describe("processReminders", () => {
  let repository: InMemoryReminderRepository;

  beforeEach(() => {
    repository = new InMemoryReminderRepository();
    repository.reset();
  });

  it("marks a due reminder sent and persists the delivery state", async () => {
    const now = Date.now();
    const reminder = await repository.create({ slotId: 7, triggerAt: now - 1_000 });
    const deliverReminder = jest.fn(async () => undefined);
    const claimDeliveryFn = jest.fn(async () => true);

    await processReminders({
      repository,
      now,
      deliverReminder,
      claimDeliveryFn,
    });

    expect(deliverReminder).toHaveBeenCalledWith(expect.objectContaining({ id: reminder.id }));
    const stored = await repository.findById(reminder.id);
    expect(stored).toMatchObject({
      status: "sent",
      attempts: 0,
      sentAt: now,
    });
  });

  it("increments attempts and keeps the reminder pending after a delivery failure", async () => {
    const now = Date.now();
    const reminder = await repository.create({ slotId: 8, triggerAt: now - 1_000 });
    const deliverReminder = jest.fn(async () => {
      throw new Error("delivery failed");
    });

    await processReminders({
      repository,
      now,
      deliverReminder,
      claimDeliveryFn: jest.fn(async () => true),
    });

    const stored = await repository.findById(reminder.id);
    expect(stored).toMatchObject({
      status: "pending",
      attempts: 1,
      lastAttemptAt: now,
    });
  });

  it("dead-letters reminders after the max retry count", async () => {
    const now = Date.now();
    const reminder = await repository.create({ slotId: 9, triggerAt: now - 1_000 });
    await repository.recordAttempt(reminder.id, now - 3_000);
    await repository.recordAttempt(reminder.id, now - 2_000);

    await processReminders({
      repository,
      now,
      maxRetries: 3,
      deliverReminder: jest.fn(async () => {
        throw new Error("delivery failed");
      }),
      claimDeliveryFn: jest.fn(async () => true),
    });

    const stored = await repository.findById(reminder.id);
    expect(stored).toMatchObject({
      status: "failed",
      attempts: 3,
      lastAttemptAt: now,
    });
  });

  it("skips duplicate deliveries when reminderDedup refuses the claim", async () => {
    const now = Date.now();
    const reminder = await repository.create({ slotId: 10, triggerAt: now - 1_000 });
    const deliverReminder = jest.fn(async () => undefined);

    await processReminders({
      repository,
      now,
      deliverReminder,
      claimDeliveryFn: jest.fn(async () => false),
    });

    expect(deliverReminder).not.toHaveBeenCalled();
    const stored = await repository.findById(reminder.id);
    expect(stored).toMatchObject({
      status: "pending",
      attempts: 0,
    });
  });
});
