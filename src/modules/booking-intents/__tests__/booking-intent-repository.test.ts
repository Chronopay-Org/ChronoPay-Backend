import {
  InMemoryBookingIntentRepository,
  type BookingIntentRecord,
} from "../booking-intent-repository.js";

describe("InMemoryBookingIntentRepository", () => {
  let repository: InMemoryBookingIntentRepository;

  beforeEach(() => {
    repository = new InMemoryBookingIntentRepository();
  });

  const createIntent = (overrides: Partial<Omit<BookingIntentRecord, "id">> = {}) =>
    repository.create({
      slotId: "slot-1",
      professional: "professional-1",
      customerId: "customer-1",
      startTime: 100,
      endTime: 200,
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    });

  describe("findLatestBySlotId", () => {
    it("returns undefined for an empty repository and a slot with no matches", async () => {
      expect(repository.findLatestBySlotId("")).toBeUndefined();
      await createIntent();
      expect(repository.findLatestBySlotId("missing-slot")).toBeUndefined();
    });

    it("returns the intent with the greatest start time for the requested slot", async () => {
      await createIntent({ startTime: 200, status: "cancelled" });
      const latest = await createIntent({ startTime: 300, status: "expired" });
      await createIntent({ startTime: 100 });
      await createIntent({ slotId: "other-slot", startTime: 400 });

      expect(repository.findLatestBySlotId("slot-1")).toEqual(latest);
    });

    it("accepts a zero start time and retains the first intent when times tie", async () => {
      const first = await createIntent({ slotId: "", startTime: 0 });
      await createIntent({ slotId: "", startTime: 0 });

      expect(repository.findLatestBySlotId("")).toEqual(first);
    });
  });

  describe("updateStatus", () => {
    it.each(["missing-id", ""])("throws the exact error for unknown id %j", (id) => {
      expect(() => repository.updateStatus(id, "cancelled")).toThrow(
        new Error(`BookingIntent with id "${id}" not found`),
      );
    });

    it("returns and stores the updated status without changing another intent", async () => {
      const intent = await createIntent();
      const other = await createIntent({ slotId: "other-slot" });

      expect(repository.updateStatus(intent.id, "cancelled")).toEqual({
        ...intent,
        status: "cancelled",
      });
      expect(repository.findById(intent.id)?.status).toBe("cancelled");
      expect(repository.findById(other.id)).toEqual(other);
    });
  });

  describe("update", () => {
    it.each(["missing-id", ""])("throws the exact error for unknown id %j", (id) => {
      expect(() => repository.update(id, { note: "changed" })).toThrow(
        new Error(`BookingIntent with id "${id}" not found`),
      );
    });

    it("merges a partial update and preserves the other fields", async () => {
      const intent = await createIntent();

      expect(repository.update(intent.id, { note: "changed" })).toEqual({
        ...intent,
        note: "changed",
      });
      expect(repository.findById(intent.id)).toEqual({ ...intent, note: "changed" });
    });

    it("accepts an empty update without changing the record", async () => {
      const intent = await createIntent();

      expect(repository.update(intent.id, {})).toEqual(intent);
    });
  });
});
