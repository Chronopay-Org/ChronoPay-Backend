import { jest } from "@jest/globals";
import { InMemoryReminderRepository, type Reminder, type ReminderStatus } from "../reminder.js";

const BASE_TIME = new Date("2026-01-01T00:00:00.000Z").getTime();

const ALL_STATUSES: ReminderStatus[] = ["pending", "sent", "failed"];

describe("InMemoryReminderRepository", () => {
  let repository: InMemoryReminderRepository;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BASE_TIME);
    repository = new InMemoryReminderRepository();
    repository.reset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const createReminder = async (
    overrides: Partial<{ slotId: number; triggerAt: number }> = {},
  ): Promise<Reminder> =>
    repository.create({
      slotId: overrides.slotId ?? 1,
      triggerAt: overrides.triggerAt ?? BASE_TIME + 60_000,
    });

  // ── create: success path ────────────────────────────────────────────────────

  describe("create", () => {
    it("returns a pending reminder with a zeroed attempt counter", async () => {
      const created = await repository.create({ slotId: 42, triggerAt: BASE_TIME + 3_600_000 });

      expect(created).toStrictEqual({
        id: "reminder-1",
        slotId: 42,
        triggerAt: BASE_TIME + 3_600_000,
        status: "pending",
        attempts: 0,
        createdAt: BASE_TIME,
        updatedAt: BASE_TIME,
      });
      expect(created.sentAt).toBeUndefined();
      expect(created.lastAttemptAt).toBeUndefined();
    });

    it("assigns monotonically increasing identifiers to successive creates", async () => {
      const first = await createReminder({ slotId: 1 });
      const second = await createReminder({ slotId: 2 });

      expect(first.id).toBe("reminder-1");
      expect(second.id).toBe("reminder-2");
    });

    it("returns a detached copy so caller mutations cannot leak into the store", async () => {
      const created = await createReminder();

      created.status = "failed";
      created.attempts = 99;

      const stored = await repository.findById(created.id);
      expect(stored).toMatchObject({ status: "pending", attempts: 0 });
    });

    it("persists reminders created with non-positive trigger timestamps", async () => {
      const zero = await repository.create({ slotId: 5, triggerAt: 0 });
      const negative = await repository.create({ slotId: 6, triggerAt: -1 });

      expect(zero.triggerAt).toBe(0);
      expect(negative.triggerAt).toBe(-1);
      expect(await repository.findById(negative.id)).toMatchObject({
        triggerAt: -1,
        status: "pending",
      });
    });
  });

  // ── findById: null / success contract ───────────────────────────────────────

  describe("findById", () => {
    it("returns null for an unknown identifier instead of throwing", async () => {
      await expect(repository.findById("reminder-does-not-exist")).resolves.toBeNull();
    });

    it("returns null for empty and near-miss identifiers", async () => {
      const created = await createReminder();

      await expect(repository.findById("")).resolves.toBeNull();
      await expect(repository.findById(" reminder-1")).resolves.toBeNull();
      await expect(repository.findById("reminder-01")).resolves.toBeNull();
      await expect(repository.findById(created.id.toUpperCase())).resolves.toBeNull();
    });

    it("returns null again after the reminder has been removed by reset()", async () => {
      const created = await createReminder();
      expect(await repository.findById(created.id)).not.toBeNull();

      repository.reset();

      await expect(repository.findById(created.id)).resolves.toBeNull();
    });

    it("returns a detached copy of the stored reminder", async () => {
      const created = await createReminder();
      const first = await repository.findById(created.id);
      const second = await repository.findById(created.id);

      expect(first).not.toBeNull();
      expect(first).not.toBe(second);
      expect(first).toEqual(second);
    });
  });

  // ── updateReminder null branch (src/models/reminder.ts:97) ─────────────────

  describe("mutations of an unknown reminder resolve to null", () => {
    const unknownId = "reminder-missing";

    it("markSent returns null and leaves the store untouched", async () => {
      const created = await createReminder();

      await expect(repository.markSent(unknownId, BASE_TIME + 5_000)).resolves.toBeNull();

      const stored = await repository.findById(created.id);
      expect(stored).toMatchObject({ status: "pending", attempts: 0 });
      expect(stored?.sentAt).toBeUndefined();
    });

    it("recordAttempt returns null and does not increment any counter", async () => {
      const created = await createReminder();
      await repository.recordAttempt(created.id, BASE_TIME + 1_000);

      await expect(repository.recordAttempt(unknownId, BASE_TIME + 5_000)).resolves.toBeNull();

      const stored = await repository.findById(created.id);
      expect(stored).toMatchObject({ attempts: 1, lastAttemptAt: BASE_TIME + 1_000 });
    });

    it("markFailed returns null and does not mark any reminder as failed", async () => {
      const created = await createReminder();

      await expect(repository.markFailed(unknownId, BASE_TIME + 5_000)).resolves.toBeNull();

      const stored = await repository.findById(created.id);
      expect(stored).toMatchObject({ status: "pending" });
      expect(stored?.lastAttemptAt).toBeUndefined();
    });

    it("is idempotent and deterministic across repeated calls", async () => {
      const results = await Promise.all([
        repository.markSent(unknownId),
        repository.recordAttempt(unknownId),
        repository.markFailed(unknownId),
        repository.markSent(unknownId),
        repository.recordAttempt(unknownId),
        repository.markFailed(unknownId),
      ]);

      expect(results).toStrictEqual([null, null, null, null, null, null]);
    });

    it("returns null rather than creating a phantom reminder", async () => {
      await repository.markSent(unknownId);
      await repository.markFailed(unknownId);

      expect(await repository.getDueReminders(BASE_TIME + 86_400_000)).toStrictEqual([]);
      await expect(repository.findById(unknownId)).resolves.toBeNull();
    });

    it("resolves a recycled id back to a real reminder after reset()", async () => {
      const created = await createReminder();
      repository.reset();
      const recycled = await createReminder();

      expect(recycled.id).toBe(created.id);
      await expect(repository.markSent(recycled.id)).resolves.toMatchObject({
        id: recycled.id,
        status: "sent",
      });
    });
  });

  // ── updateReminder success paths ───────────────────────────────────────────

  describe("markSent", () => {
    it("transitions a pending reminder to sent and stamps sentAt", async () => {
      const created = await createReminder();
      jest.setSystemTime(BASE_TIME + 7_000);

      const sent = await repository.markSent(created.id);

      expect(sent).toMatchObject({
        id: created.id,
        status: "sent",
        sentAt: BASE_TIME + 7_000,
        updatedAt: BASE_TIME + 7_000,
        attempts: 0,
      });
      expect(await repository.findById(created.id)).toEqual(sent);
    });

    it("honours an explicit sentAt and overwrites a previously stamped value", async () => {
      const created = await createReminder();
      await repository.markSent(created.id, BASE_TIME + 1_000);

      const resent = await repository.markSent(created.id, BASE_TIME + 2_000);

      expect(resent?.sentAt).toBe(BASE_TIME + 2_000);
      expect(resent?.status).toBe("sent");
    });

    it("leaves a sent reminder out of the due set", async () => {
      const created = await createReminder({ triggerAt: BASE_TIME - 1 });
      await repository.markSent(created.id);

      expect(await repository.getDueReminders(BASE_TIME + 86_400_000)).toStrictEqual([]);
    });
  });

  describe("recordAttempt", () => {
    it("increments attempts and stamps lastAttemptAt", async () => {
      const created = await createReminder();

      const afterFirst = await repository.recordAttempt(created.id, BASE_TIME + 1_000);
      expect(afterFirst).toMatchObject({
        attempts: 1,
        lastAttemptAt: BASE_TIME + 1_000,
        status: "pending",
      });

      const afterSecond = await repository.recordAttempt(created.id, BASE_TIME + 2_000);
      expect(afterSecond).toMatchObject({
        attempts: 2,
        lastAttemptAt: BASE_TIME + 2_000,
      });
    });

    it("derives updatedAt from the repository clock rather than attemptedAt", async () => {
      const created = await createReminder();
      jest.setSystemTime(BASE_TIME + 3_000);

      const afterAttempt = await repository.recordAttempt(created.id, BASE_TIME + 1_000);

      expect(afterAttempt?.lastAttemptAt).toBe(BASE_TIME + 1_000);
      expect(afterAttempt?.updatedAt).toBe(BASE_TIME + 3_000);
    });

    it("does not change status, so a failed reminder can still record attempts", async () => {
      const created = await createReminder();
      await repository.markFailed(created.id, BASE_TIME + 1_000);

      const afterAttempt = await repository.recordAttempt(created.id, BASE_TIME + 2_000);

      expect(afterAttempt).toMatchObject({
        status: "failed",
        attempts: 1,
        lastAttemptAt: BASE_TIME + 2_000,
      });
    });

    it("defaults attemptedAt to the current clock", async () => {
      const created = await createReminder();
      jest.setSystemTime(BASE_TIME + 4_321);

      const afterAttempt = await repository.recordAttempt(created.id);

      expect(afterAttempt?.lastAttemptAt).toBe(BASE_TIME + 4_321);
    });
  });

  describe("markFailed", () => {
    it("transitions a pending reminder to failed and stamps lastAttemptAt", async () => {
      const created = await createReminder();

      const failed = await repository.markFailed(created.id, BASE_TIME + 9_000);

      expect(failed).toMatchObject({
        status: "failed",
        lastAttemptAt: BASE_TIME + 9_000,
        attempts: 0,
      });
      expect(failed?.sentAt).toBeUndefined();
    });

    it("derives updatedAt from the repository clock rather than failedAt", async () => {
      const created = await createReminder();
      jest.setSystemTime(BASE_TIME + 3_000);

      const failed = await repository.markFailed(created.id, BASE_TIME + 9_000);

      expect(failed?.lastAttemptAt).toBe(BASE_TIME + 9_000);
      expect(failed?.updatedAt).toBe(BASE_TIME + 3_000);
    });

    it("keeps a failed reminder out of the due set", async () => {
      const created = await createReminder({ triggerAt: BASE_TIME - 1 });
      await repository.markFailed(created.id);

      expect(await repository.getDueReminders(BASE_TIME + 86_400_000)).toStrictEqual([]);
    });

    it("can move a sent reminder to failed without clearing sentAt", async () => {
      const created = await createReminder();
      await repository.markSent(created.id, BASE_TIME + 1_000);

      const failed = await repository.markFailed(created.id, BASE_TIME + 2_000);

      expect(failed).toMatchObject({ status: "failed", sentAt: BASE_TIME + 1_000 });
    });

    it("defaults failedAt to the current clock", async () => {
      const created = await createReminder();
      jest.setSystemTime(BASE_TIME + 6_000);

      const failed = await repository.markFailed(created.id);

      expect(failed?.lastAttemptAt).toBe(BASE_TIME + 6_000);
      expect(failed?.updatedAt).toBe(BASE_TIME + 6_000);
    });
  });

  // ── getDueReminders boundaries ──────────────────────────────────────────────

  describe("getDueReminders", () => {
    it("includes a reminder whose triggerAt is exactly now", async () => {
      const onTime = await createReminder({ slotId: 1, triggerAt: BASE_TIME });
      const future = await createReminder({ slotId: 2, triggerAt: BASE_TIME + 1 });

      const due = await repository.getDueReminders(BASE_TIME);

      expect(due.map((reminder) => reminder.id)).toStrictEqual([onTime.id]);
      expect(future.status).toBe("pending");
    });

    it("returns an empty array when nothing is due", async () => {
      await createReminder({ triggerAt: BASE_TIME + 1 });

      expect(await repository.getDueReminders(BASE_TIME)).toStrictEqual([]);
    });

    it("returns an empty array for an empty store", async () => {
      expect(await repository.getDueReminders(BASE_TIME)).toStrictEqual([]);
    });

    it("returns an empty array for a zero or negative limit", async () => {
      await createReminder({ triggerAt: BASE_TIME - 1 });

      expect(await repository.getDueReminders(BASE_TIME, 0)).toStrictEqual([]);
      expect(await repository.getDueReminders(BASE_TIME, -1)).toStrictEqual([]);
    });

    it("caps results at the requested limit", async () => {
      await createReminder({ slotId: 1, triggerAt: BASE_TIME - 3 });
      await createReminder({ slotId: 2, triggerAt: BASE_TIME - 2 });
      await createReminder({ slotId: 3, triggerAt: BASE_TIME - 1 });

      const due = await repository.getDueReminders(BASE_TIME, 2);

      expect(due).toHaveLength(2);
      expect(due.map((reminder) => reminder.slotId)).toStrictEqual([1, 2]);
    });

    it("returns every pending reminder when the limit exceeds the due count", async () => {
      await createReminder({ slotId: 1, triggerAt: BASE_TIME - 1 });
      await createReminder({ slotId: 2, triggerAt: BASE_TIME - 1 });

      expect(await repository.getDueReminders(BASE_TIME, 1_000)).toHaveLength(2);
    });

    it("defaults the limit to 100", async () => {
      for (let index = 0; index < 105; index += 1) {
        await repository.create({ slotId: index, triggerAt: BASE_TIME - 1 });
      }

      expect(await repository.getDueReminders(BASE_TIME)).toHaveLength(100);
    });

    it("excludes non-pending reminders regardless of triggerAt", async () => {
      const sent = await createReminder({ slotId: 1, triggerAt: BASE_TIME - 10 });
      const failed = await createReminder({ slotId: 2, triggerAt: BASE_TIME - 10 });
      const pending = await createReminder({ slotId: 3, triggerAt: BASE_TIME - 10 });
      await repository.markSent(sent.id, BASE_TIME);
      await repository.markFailed(failed.id, BASE_TIME);

      const due = await repository.getDueReminders(BASE_TIME);

      expect(due.map((reminder) => reminder.id)).toStrictEqual([pending.id]);
    });

    it("returns detached copies that cannot mutate the store", async () => {
      const created = await createReminder({ triggerAt: BASE_TIME - 1 });
      const [first] = await repository.getDueReminders(BASE_TIME);
      first.status = "failed";

      expect(await repository.findById(created.id)).toMatchObject({ status: "pending" });
    });
  });

  // ── reset / lifecycle boundaries ───────────────────────────────────────────

  describe("reset", () => {
    it("clears stored reminders and restarts the id counter", async () => {
      await createReminder({ slotId: 1 });
      await createReminder({ slotId: 2 });

      repository.reset();

      expect(await repository.getDueReminders(BASE_TIME + 86_400_000)).toStrictEqual([]);
      expect((await repository.create({ slotId: 3, triggerAt: BASE_TIME })).id).toBe("reminder-1");
    });

    it("is safe to call on an already empty store", async () => {
      repository.reset();
      repository.reset();

      expect(await repository.getDueReminders(BASE_TIME)).toStrictEqual([]);
    });

    it("clears state shared across repository instances", async () => {
      const other = new InMemoryReminderRepository();
      await createReminder();

      other.reset();

      expect(await repository.getDueReminders(BASE_TIME + 86_400_000)).toStrictEqual([]);
    });
  });

  // ── ReminderStatus contract ────────────────────────────────────────────────

  describe("ReminderStatus contract", () => {
    it("produces only the documented status values", async () => {
      const created = await createReminder();
      const observed: ReminderStatus[] = [created.status];

      observed.push((await repository.recordAttempt(created.id))!.status);
      observed.push((await repository.markSent(created.id))!.status);
      observed.push((await repository.markFailed(created.id))!.status);

      for (const status of observed) {
        expect(ALL_STATUSES).toContain(status);
      }
    });

    it("keeps a failed terminal state until it is explicitly re-driven", async () => {
      const created = await createReminder();
      await repository.markFailed(created.id, BASE_TIME + 1_000);

      jest.setSystemTime(BASE_TIME + 10_000);
      const after = await repository.recordAttempt(created.id);

      expect(after).toMatchObject({
        status: "failed",
        attempts: 1,
        lastAttemptAt: BASE_TIME + 10_000,
      });
      expect(await repository.getDueReminders(BASE_TIME + 10_000)).toStrictEqual([]);
    });
  });
});
