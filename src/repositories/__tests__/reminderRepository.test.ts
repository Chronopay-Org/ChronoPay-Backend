import { jest } from "@jest/globals";
import { PgReminderRepository } from "../reminderRepository.js";

type DbCall = { text: string; params?: unknown[] };

function makeRepo(rows: any[] = []) {
  const calls: DbCall[] = [];
  const dbQuery = (async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    return { rows };
  }) as any;

  return { repo: new PgReminderRepository(dbQuery), calls };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slot_id: "12",
    trigger_at: "2026-11-23T10:00:00.000Z",
    status: "pending",
    attempts: "0",
    last_attempt_at: null,
    sent_at: null,
    created_at: "2026-11-23T09:00:00.000Z",
    updated_at: "2026-11-23T09:00:00.000Z",
    ...overrides,
  };
}

describe("PgReminderRepository", () => {
  it("create passes epoch milliseconds and maps the returned row", async () => {
    const now = 1_700_000_000_000;
    const dateSpy = jest.spyOn(Date, "now").mockReturnValue(now);
    const { repo, calls } = makeRepo([row({ slot_id: "slot-abc" })]);

    const reminder = await repo.create({
      slotId: "slot-abc",
      triggerAt: 1_700_000_360_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("to_timestamp($2 / 1000.0)");
    expect(calls[0].text).toContain("to_timestamp($3 / 1000.0)");
    expect(calls[0].params).toEqual(["slot-abc", 1_700_000_360_000, now]);
    expect(reminder).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      slotId: "slot-abc",
      triggerAt: new Date("2026-11-23T10:00:00.000Z").getTime(),
      status: "pending",
      attempts: 0,
      lastAttemptAt: undefined,
      sentAt: undefined,
      createdAt: new Date("2026-11-23T09:00:00.000Z").getTime(),
      updatedAt: new Date("2026-11-23T09:00:00.000Z").getTime(),
    });

    dateSpy.mockRestore();
  });

  it("findById passes the id and maps timestamps and attempt count", async () => {
    const { repo, calls } = makeRepo([
      row({
        slot_id: "12",
        attempts: "3",
        last_attempt_at: "2026-11-23T09:30:00.000Z",
        sent_at: "2026-11-23T09:31:00.000Z",
      }),
    ]);

    const reminder = await repo.findById("reminder-id");

    expect(calls[0].params).toEqual(["reminder-id"]);
    expect(reminder).toMatchObject({
      slotId: 12,
      attempts: 3,
      lastAttemptAt: new Date("2026-11-23T09:30:00.000Z").getTime(),
      sentAt: new Date("2026-11-23T09:31:00.000Z").getTime(),
    });
  });

  it("findBySlotAndTrigger queries with string slot id and epoch milliseconds", async () => {
    const { repo, calls } = makeRepo([row({ slot_id: "slot-abc" })]);

    const reminder = await repo.findBySlotAndTrigger("slot-abc", 1_700_000_360_000);

    expect(calls[0].params).toEqual(["slot-abc", 1_700_000_360_000]);
    expect(calls[0].text).toContain("trigger_at = to_timestamp($2 / 1000.0)");
    expect(reminder?.slotId).toBe("slot-abc");
  });

  it("getDueReminders defaults to limit 100 and orders by trigger then creation", async () => {
    const { repo, calls } = makeRepo([row()]);

    const reminders = await repo.getDueReminders(1_700_000_000_000);

    expect(calls[0].params).toEqual([1_700_000_000_000, 100]);
    expect(calls[0].text).toContain("to_timestamp($1 / 1000.0)");
    expect(calls[0].text).toContain("ORDER BY trigger_at ASC, created_at ASC");
    expect(reminders).toHaveLength(1);
  });

  it("markSent passes sent epoch milliseconds and returns null for no row", async () => {
    const { repo, calls } = makeRepo([]);

    const result = await repo.markSent("reminder-id", 1_700_000_000_123);

    expect(calls[0].params).toEqual(["reminder-id", 1_700_000_000_123]);
    expect(calls[0].text).toContain("to_timestamp($2 / 1000.0)");
    expect(result).toBeNull();
  });

  it("recordAttempt passes attempted epoch milliseconds and returns null for no row", async () => {
    const { repo, calls } = makeRepo([]);

    const result = await repo.recordAttempt("reminder-id", 1_700_000_000_456);

    expect(calls[0].params).toEqual(["reminder-id", 1_700_000_000_456]);
    expect(calls[0].text).toContain("to_timestamp($2 / 1000.0)");
    expect(result).toBeNull();
  });

  it("markFailed passes failed epoch milliseconds and returns null for no row", async () => {
    const { repo, calls } = makeRepo([]);

    const result = await repo.markFailed("reminder-id", 1_700_000_000_789);

    expect(calls[0].params).toEqual(["reminder-id", 1_700_000_000_789]);
    expect(calls[0].text).toContain("to_timestamp($2 / 1000.0)");
    expect(result).toBeNull();
  });

  it("findById maps missing last_attempt_at and sent_at to undefined", async () => {
    const { repo } = makeRepo([row()]);

    const reminder = await repo.findById("reminder-id");

    expect(reminder?.lastAttemptAt).toBeUndefined();
    expect(reminder?.sentAt).toBeUndefined();
  });
});
