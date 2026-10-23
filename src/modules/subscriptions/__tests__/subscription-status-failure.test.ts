/**
 * Focused behavior coverage for the SubscriptionStatus failure path in
 * src/modules/subscriptions/subscription-repository.ts.
 *
 * The neighbouring `subscription-repositories.test.ts` asserts that a bad
 * update throws something matching /not found/. This suite pins the exact
 * failure contract and the surrounding state transitions:
 *  - the exact interpolated error message (and that it is a plain Error)
 *  - a failed update leaves the stored record completely untouched
 *  - active -> paused -> cancelled transitions round-trip through update()
 *  - update() preserves id/createdAt and bumps updatedAt
 *  - reads return defensive copies
 *  - findByProductAndSubscriber / listActiveDueBefore boundaries
 */

import {
  InMemorySubscriptionRepository,
  type SubscriptionRecord,
  type SubscriptionStatus,
} from "../subscription-repository.js";

function makeSub(
  overrides: Partial<Omit<SubscriptionRecord, "id" | "createdAt" | "updatedAt">> = {},
): Omit<SubscriptionRecord, "id" | "createdAt" | "updatedAt"> {
  return {
    productId: "sp-1",
    subscriberId: "user-1",
    status: "active",
    nextSlotStartMs: 1_700_000_000_000,
    slotOffsetMs: 0,
    slotsMinted: 0,
    pausedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

describe("SubscriptionRepository update() failure handling", () => {
  let repo: InMemorySubscriptionRepository;

  beforeEach(() => {
    repo = new InMemorySubscriptionRepository();
  });

  it("throws a plain Error naming the missing subscription id", () => {
    let caught: unknown;
    try {
      repo.update("missing-sub", { status: "cancelled" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("Error");
    expect((caught as Error).message).toBe("Subscription missing-sub not found");
  });

  it("interpolates the id verbatim, including empty and unusual values", () => {
    for (const id of ["", "sub-999", "  spaced  ", "sub/with/slashes"]) {
      expect(() => repo.update(id, { status: "paused" })).toThrow(
        `Subscription ${id} not found`,
      );
    }
  });

  it("leaves the stored record untouched when the update fails", () => {
    const created = repo.create(makeSub({ productId: "sp-keep", slotsMinted: 3 }));
    const before = repo.findById(created.id);

    expect(() => repo.update("does-not-exist", { status: "cancelled" })).toThrow();

    expect(repo.findById(created.id)).toEqual(before);
    expect(repo.findById(created.id)!.status).toBe("active");
    expect(repo.findById(created.id)!.slotsMinted).toBe(3);
    expect(repo.findById(created.id)!.updatedAt).toBe(created.updatedAt);
    // ...and no phantom record was appended.
    expect(repo.listActiveByProduct("sp-keep")).toHaveLength(1);
  });

  it("succeeds for an existing id and never throws", () => {
    const created = repo.create(makeSub());

    expect(() => repo.update(created.id, { status: "paused" })).not.toThrow();
  });
});

describe("SubscriptionStatus transitions", () => {
  let repo: InMemorySubscriptionRepository;

  beforeEach(() => {
    repo = new InMemorySubscriptionRepository();
  });

  it("round-trips every status value through update()", () => {
    const created = repo.create(makeSub());

    const statuses: SubscriptionStatus[] = ["paused", "cancelled", "active"];
    for (const status of statuses) {
      expect(repo.update(created.id, { status }).status).toBe(status);
      expect(repo.findById(created.id)!.status).toBe(status);
    }
  });

  it("moves active -> paused while preserving identity fields", () => {
    const created = repo.create(makeSub({ status: "active" }));

    const updated = repo.update(created.id, { status: "paused", pausedAt: "2026-01-01T00:00:00.000Z" });

    expect(updated.status).toBe("paused");
    expect(updated.pausedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toEqual(expect.any(String));
  });

  it("moves paused -> cancelled while preserving identity fields", () => {
    const created = repo.create(makeSub({ status: "paused" }));

    const updated = repo.update(created.id, {
      status: "cancelled",
      cancelledAt: "2026-02-02T00:00:00.000Z",
    });

    expect(updated.status).toBe("cancelled");
    expect(updated.cancelledAt).toBe("2026-02-02T00:00:00.000Z");
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it("applies an empty patch as a no-op that keeps the record intact", () => {
    const created = repo.create(makeSub({ slotsMinted: 4 }));

    const updated = repo.update(created.id, {});

    expect(updated).toEqual(repo.findById(created.id));
    expect(updated.slotsMinted).toBe(4);
    expect(updated.status).toBe("active");
  });
});

describe("read isolation and lookup boundaries", () => {
  let repo: InMemorySubscriptionRepository;

  beforeEach(() => {
    repo = new InMemorySubscriptionRepository();
  });

  it("returns defensive copies from findById and update", () => {
    const created = repo.create(makeSub());

    const found = repo.findById(created.id)!;
    found.status = "cancelled";
    expect(repo.findById(created.id)!.status).toBe("active");

    const updated = repo.update(created.id, { slotsMinted: 9 });
    updated.slotsMinted = 99;
    expect(repo.findById(created.id)!.slotsMinted).toBe(9);
  });

  it("matches active and paused subscriptions but never cancelled ones", () => {
    const active = repo.create(makeSub({ subscriberId: "active", status: "active" }));
    const paused = repo.create(makeSub({ subscriberId: "paused", status: "paused" }));
    repo.create(makeSub({ subscriberId: "cancelled", status: "cancelled" }));

    expect(repo.findByProductAndSubscriber("sp-1", "active")?.id).toBe(active.id);
    expect(repo.findByProductAndSubscriber("sp-1", "paused")?.id).toBe(paused.id);
    expect(repo.findByProductAndSubscriber("sp-1", "cancelled")).toBeUndefined();
    expect(repo.findByProductAndSubscriber("sp-1", "unknown")).toBeUndefined();
  });

  it("treats the listActiveDueBefore cutoff as inclusive", () => {
    repo.create(makeSub({ subscriberId: "a", nextSlotStartMs: 1000 }));
    repo.create(makeSub({ subscriberId: "b", nextSlotStartMs: 2000 }));

    expect(repo.listActiveDueBefore(1000, 10).map((s) => s.subscriberId)).toEqual(["a"]);
    expect(repo.listActiveDueBefore(1999, 10)).toHaveLength(1);
    expect(repo.listActiveDueBefore(2000, 10)).toHaveLength(2);
  });

  it("returns an empty list for a zero batch size or a past cutoff", () => {
    repo.create(makeSub({ nextSlotStartMs: 1000 }));

    expect(repo.listActiveDueBefore(9999, 0)).toEqual([]);
    expect(repo.listActiveDueBefore(0, 10)).toEqual([]);
  });

  it("excludes non-active statuses from the due queue", () => {
    repo.create(makeSub({ subscriberId: "active", status: "active", nextSlotStartMs: 1000 }));
    repo.create(makeSub({ subscriberId: "paused", status: "paused", nextSlotStartMs: 1000 }));
    repo.create(makeSub({ subscriberId: "cancelled", status: "cancelled", nextSlotStartMs: 1000 }));

    const due = repo.listActiveDueBefore(5000, 10);
    expect(due.map((s) => s.subscriberId)).toEqual(["active"]);
  });

  it("orders the due queue by nextSlotStartMs", () => {
    repo.create(makeSub({ subscriberId: "third", nextSlotStartMs: 3000 }));
    repo.create(makeSub({ subscriberId: "first", nextSlotStartMs: 1000 }));
    repo.create(makeSub({ subscriberId: "second", nextSlotStartMs: 2000 }));

    expect(repo.listActiveDueBefore(5000, 10).map((s) => s.subscriberId)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("lists only active subscriptions per product", () => {
    repo.create(makeSub({ productId: "sp-1", status: "active" }));
    repo.create(makeSub({ productId: "sp-1", status: "paused" }));
    repo.create(makeSub({ productId: "sp-2", status: "active" }));

    expect(repo.listActiveByProduct("sp-1")).toHaveLength(1);
    expect(repo.listActiveByProduct("sp-2")).toHaveLength(1);
    expect(repo.listActiveByProduct("unknown")).toEqual([]);
  });
});
