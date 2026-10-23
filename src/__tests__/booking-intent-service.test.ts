/// <reference types="jest" />
import {
  parseCreateBookingIntentBody,
  BookingIntentError,
  BookingIntentService,
  type BookingIntentRepository,
  type CreateBookingIntentInput,
} from "../modules/booking-intents/booking-intent-service.js";
import { InMemoryBookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";

const VALID_SLOT_ID = "slot-11111111-1111-4111-8111-111111111111";

describe("parseCreateBookingIntentBody", () => {
  it("accepts valid booking intent without note", () => {
    const result = parseCreateBookingIntentBody({ slotId: VALID_SLOT_ID });
    expect(result).toEqual({ slotId: VALID_SLOT_ID });
  });

  it("accepts valid booking intent with note", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "This is a note",
    });
    expect(result).toEqual({ slotId: VALID_SLOT_ID, note: "This is a note" });
  });

  it("trims slotId", () => {
    const result = parseCreateBookingIntentBody({ slotId: `  ${VALID_SLOT_ID}  ` });
    expect((result as any).slotId).toBe(VALID_SLOT_ID);
  });

  it("rejects empty slotId", () => {
    expect(() => parseCreateBookingIntentBody({ slotId: "" })).toThrow(
      BookingIntentError,
    );
    expect(() => parseCreateBookingIntentBody({ slotId: "   " })).toThrow(
      BookingIntentError,
    );
  });

  it("rejects invalid slotId format", () => {
    expect(() => parseCreateBookingIntentBody({ slotId: "ab" })).toThrow(
      BookingIntentError,
    );
    expect(() => parseCreateBookingIntentBody({ slotId: "a".repeat(65) })).toThrow(
      BookingIntentError,
    );
    expect(() => parseCreateBookingIntentBody({ slotId: "abc_123" })).toThrow(
      BookingIntentError,
    );
    expect(() => parseCreateBookingIntentBody({ slotId: "abc@123" })).toThrow(
      BookingIntentError,
    );
  });

  it("rejects non-object body", () => {
    expect(() => parseCreateBookingIntentBody(null)).toThrow(BookingIntentError);
    expect(() => parseCreateBookingIntentBody(undefined)).toThrow(
      BookingIntentError,
    );
    expect(() => parseCreateBookingIntentBody([])).toThrow(BookingIntentError);
    expect(() => parseCreateBookingIntentBody("string")).toThrow(
      BookingIntentError,
    );
    expect(() => parseCreateBookingIntentBody(123)).toThrow(BookingIntentError);
  });

  it("rejects non-string note", () => {
    expect(() =>
      parseCreateBookingIntentBody({ slotId: VALID_SLOT_ID, note: 123 }),
    ).toThrow(BookingIntentError);
    expect(() =>
      parseCreateBookingIntentBody({ slotId: VALID_SLOT_ID, note: null }),
    ).toThrow(BookingIntentError);
    expect(() =>
      parseCreateBookingIntentBody({ slotId: VALID_SLOT_ID, note: {} }),
    ).toThrow(BookingIntentError);
    expect(() =>
      parseCreateBookingIntentBody({ slotId: VALID_SLOT_ID, note: [] }),
    ).toThrow(BookingIntentError);
  });

  it("sanitizes note by removing control characters", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "Hello\0x00World",
    });
    expect(result.note).toBe("HelloWorld");
  });

  it("sanitizes note by removing C1 control characters", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "Hello\x80World",
    });
    expect(result.note).toBe("HelloWorld");
  });

  it("preserves tab, newline, and carriage return in note", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "Line1\nLine2\TTabbed\rReturn",
    });
    expect(result.note).toBe("Line1\nLine2\TTabbed\rReturn");
  });

  it("normalizes unicode in note to NFC", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "Cafe\u0301",
    });
    expect(result.note).toBe("Café");
  });

  it("trims whitespace from note", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "  Hello World  ",
    });
    expect(result.note).toBe("Hello World");
  });

  it("rejects empty note after sanitization", () => {
    expect(() =>
      parseCreateBookingIntentBody({ slotId: VALID_SLOT_ID, note: "   " }),
    ).toThrow(BookingIntentError);
    expect(() =>
      parseCreateBookingIntentBody({ slotId: VALID_SLOT_ID, note: "\x00\x01\x02" }),
    ).toThrow(BookingIntentError);
    expect(() =>
      parseCreateBookingIntentBody({ slotId: VALID_SLOT_ID, note: "\t\n\r" }),
    ).toThrow(BookingIntentError);
  });

  it("rejects note exceeding 500 characters after sanitization", () => {
    const longNote = "A".repeat(501);
    expect(() =>
      parseCreateBookingIntentBody({ slotId: VALID_SLOT_ID, note: longNote }),
    ).toThrow(BookingIntentError);
  });

  it("accepts note exactly 500 characters after sanitization", () => {
    const longNote = "A".repeat(500);
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: longNote,
    });
    expect(result.note).toBe(longNote);
  });

  it("handles note with embedded newlines", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "Line1\nLine2\nLine3",
    });
    expect(result.note).toBe("Line1\nLine2\nLine3");
  });

  it("handles note with null bytes", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "Hello\x00World",
    });
    expect(result.note).toBe("HelloWorld");
  });

  it("handles note with mixed control characters", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "Hello\x00World\x01Test\x02End",
    });
    expect(result.note).toBe("HelloWorldTestEnd");
  });

  it("handles note with unicode characters", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "Hello 世界 Café",
    });
    expect(result.note).toBe("Hello 世界  Café");
  });

  it("handles note with zero-width characters", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "Hello\u200BWorld",
    });
    expect(result.note).toBe("Hello\u200BWorld");
  });

  it("rejects note that becomes empty after stripping control characters", () => {
    expect(() =>
      parseCreateBookingIntentBody({ slotId: VALID_SLOT_ID, note: "\x00\x01\x02" }),
    ).toThrow(BookingIntentError);
  });

  it("handles note with combining marks and checks length after normalization", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "e\u0301",
    });
    expect(result.note).toBe("é");
    expect(result.note?.length).toBe(1);
  });

  it("validates slotId format with canonical format", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "Test",
    });
    expect((result as any).slotId).toBe(
      VALID_SLOT_ID,
    );
  });

  it("rejects slotId with special characters", () => {
    expect(() =>
      parseCreateBookingIntentBody({ slotId: "abc@123" }),
    ).toThrow(BookingIntentError);
    expect(() =>
      parseCreateBookingIntentBody({ slotId: "abc#123" }),
    ).toThrow(BookingIntentError);
    expect(() =>
      parseCreateBookingIntentBody({ slotId: "abc 123" }),
    ).toThrow(BookingIntentError);
  });
});

// -----------------------------------------------------------------------------
// Concurrency / atomicity tests for BookingIntentService.createIntent
// -----------------------------------------------------------------------------

const SLOT_ID = "slot-22222222-2222-4222-8222-222222222222";
const CUSTOMER_A = "customer-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CUSTOMER_B = "customer-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type DelayedFx = {
  convert: (amount: number, from: string, to: string) => Promise<number>;
  release: () => void;
};

function makeDelayedFx(): DelayedFx {
  let resolve: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    resolve = r;
  });
  return {
    async convert(amount: number) {
      await gate;
      return amount;
    },
    release() {
      resolve?.();
      resolve = null;
    },
  };
}

function makeService(opts: {
  repo?: InMemoryBookingIntentRepository;
  fx?: DelayedFx;
} = {}) {
  const repo = opts.repo ?? new InMemoryBookingIntentRepository();
  const fx = opts.fx;
  const service = new BookingIntentService({
    repository: repo as unknown as BookingIntentRepository,
    ...(fx
      ? {
          fxProvider: {
            convert: (a: number, f: string, t: string) => fx.convert(a, f, t),
          },
        }
      : {}),
  });
  return { service, repo, fx };
}

function input(customerId: string): CreateBookingIntentInput {
  return {
    slotId: SLOT_ID,
    customerId: customerId,
    amount: 100,
    currency: "USD",
  } as CreateBookingIntentInput;
}

describe("BookingIntentService.createIntent concurrency", () => {
  it("sequential happy path creates an intent and reserves the slot", async () => {
    const { service, repo } = makeService();
    const result = await service.createIntent(input(CUSTOMER_A));
    expect(result).toBeDefined();
    const active = await repo.findBySlotId(SLOT_ID);
    expect(active).toHaveLength(1);
  });

  it("concurrent createIntent calls for the same slot yield exactly one success and one 409", async () => {
    const fx = makeDelayedFx();
    const { service, repo } = makeService({ fx });

    const results = await Promise.allSettled([
      service.createIntent(input(CUSTOMER_A)),
      service.createIntent(input(CUSTOMER_B)),
    ]);

    // Release the FX gate so any waiting calls can proceed.
    fx.release();

    // Wait for any still-pending calls to settle after release.
    const settled = await Promise.allSettled(
      results.map((r) =>
        r.status === "fulfilled" ? Promise.resolve(r) : Promise.resolve(r),
      ),
    );
    void settled;

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const err = rejected[0].reason as BookingIntentError;
    expect(err).toBe9InstanceOf(BookingIntentError);
    expect(err.status).toBe(409);

    const active = await repo.findBySlotId(SLOT_ID);
    expect(active).toHaveLength(1);
  });

  it("rolls back the slot reservation when creation fails", async () => {
    const repo = new InMemoryBookingIntentRepository();
    // Force creation to fail after reservation.
    const originalCreate = repo.create.bind(repo);
    jest.spyOn(repo, "create").mockImplementation(async () => {
      throw new Error("injected create failure");
    });
    const { service } = makeService({ repo });

    await expect(service.createIntent(input(CUSTOMER_A))).rejects.toThrow();

    // Restore create and verify the slot is not left reserved.
    (repo.create as jest.Mock).mockRestore();
    void originalCreate;

    const active = await repo.findBySlotId(SLOT_ID);
    expect(active).toHaveLength(0);

    // A subsequent create for the same slot must succeed.
    const result = await service.createIntent(input(CUSTOMER_B));
    expect(result).toBeDefined();
  });
});
