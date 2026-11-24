import { PgReminderRepository } from "../repositories/reminderRepository.js";

type Call = { text: string; params?: unknown[] };

function makeRepo(rows: any[] = []) {
  const calls: Call[] = [];
  const repo = new PgReminderRepository((async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    return { rows };
  }) as any);
  return { repo, calls };
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

describe("PgReminderRepository slot ids", () => {
  describe("findBySlotAndTrigger", () => {
    it("queries by slot id as text and by the same to_timestamp expression create() uses", async () => {
      const { repo, calls } = makeRepo([]);

      await repo.findBySlotAndTrigger("slot-abc", 1_700_000_000_123);

      expect(calls).toHaveLength(1);
      const sql = calls[0].text.replace(/\s+/g, " ");
      expect(sql).toContain("FROM reminders");
      expect(sql).toContain("slot_id = $1");
      expect(sql).toContain("trigger_at = to_timestamp($2 / 1000.0)");
      expect(sql).toContain("LIMIT 1");
      expect(calls[0].params).toEqual(["slot-abc", 1_700_000_000_123]);
    });

    it("sends a numeric slot id as text so it matches the TEXT column", async () => {
      const { repo, calls } = makeRepo([]);
      await repo.findBySlotAndTrigger(12, 5000);
      expect(calls[0].params).toEqual(["12", 5000]);
    });

    it("does not filter on status, so sent and failed reminders count as existing", async () => {
      const { repo, calls } = makeRepo([]);
      await repo.findBySlotAndTrigger("slot-abc", 1);
      expect(calls[0].text).not.toMatch(/status/i);
    });

    it("returns null when no row matches", async () => {
      const { repo } = makeRepo([]);
      expect(await repo.findBySlotAndTrigger("slot-abc", 1)).toBeNull();
    });

    it("returns the mapped reminder when a row matches", async () => {
      const { repo } = makeRepo([row({ slot_id: "slot-abc" })]);
      const found = await repo.findBySlotAndTrigger("slot-abc", 1);
      expect(found).toMatchObject({
        id: "11111111-1111-4111-8111-111111111111",
        slotId: "slot-abc",
        status: "pending",
        attempts: 0,
      });
    });
  });

  describe("row mapping", () => {
    it("returns legacy integer slot ids as numbers", async () => {
      const { repo } = makeRepo([row({ slot_id: "12" })]);
      expect((await repo.findById("x"))?.slotId).toBe(12);
    });

    it("returns numeric (non-string) driver values as numbers too", async () => {
      const { repo } = makeRepo([row({ slot_id: 7 })]);
      expect((await repo.findById("x"))?.slotId).toBe(7);
    });

    it("returns UUID-style slot ids verbatim instead of NaN", async () => {
      const id = "slot-9b2f6c1e-4d7a-4f3b-8a51-0c5e7d2b9a10";
      const { repo } = makeRepo([row({ slot_id: id })]);
      expect((await repo.findById("x"))?.slotId).toBe(id);
    });

    it("maps timestamps and counters", async () => {
      const { repo } = makeRepo([
        row({ last_attempt_at: "2026-11-23T09:30:00.000Z", sent_at: "2026-11-23T09:31:00.000Z" }),
      ]);
      const r = await repo.findById("x");
      expect(r?.triggerAt).toBe(new Date("2026-11-23T10:00:00.000Z").getTime());
      expect(r?.lastAttemptAt).toBe(new Date("2026-11-23T09:30:00.000Z").getTime());
      expect(r?.sentAt).toBe(new Date("2026-11-23T09:31:00.000Z").getTime());
    });
  });

  describe("create", () => {
    it("passes the slot id through unchanged and returns it mapped", async () => {
      const { repo, calls } = makeRepo([row({ slot_id: "slot-abc" })]);

      const created = await repo.create({ slotId: "slot-abc", triggerAt: 1_700_000_000_000 });

      expect(calls[0].params?.[0]).toBe("slot-abc");
      expect(calls[0].params?.[1]).toBe(1_700_000_000_000);
      expect(created.slotId).toBe("slot-abc");
    });
  });
});
