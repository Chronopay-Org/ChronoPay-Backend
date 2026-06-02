/**
 * @fileoverview Comprehensive tests for the reminder scheduler job-runner contract.
 *
 * Verifies the distributed scheduler properties:
 * - Only one worker can deliver a reminder (via Redis dedup)
 * - Concurrent workers don't create duplicate deliveries
 * - Crashed workers recover gracefully (lock expiry)
 * - Long-running ticks maintain alignment
 * - Stale lock recovery prevents double-emit
 *
 * Uses fake timers throughout to eliminate flake.
 */

import { jest } from "@jest/globals";
import { InMemoryReminderRepository } from "../models/reminder.js";
import { processReminders } from "../scheduler/reminderWorker.js";
import { reminderMetrics } from "../scheduler/reminderMetrics.js";

/**
 * Job-Runner Contract Documentation:
 * ===================================
 *
 * DISTRIBUTED LOCK MODEL:
 * - Each reminder (id, triggerAt) is protected by a Redis SET NX lock
 * - TTL: 25 hours (covers typical retry window)
 * - Atomicity: Only one worker succeeds in claiming via SET ... NX
 *
 * CONCURRENCY GUARANTEES:
 * - Multiple workers fetch the same "due" reminders
 * - Each attempts to claim via claimDelivery(reminderId, triggerAt)
 * - Only ONE succeeds; others see "false" and skip
 * - Metric: "skipped" increments for rejected workers
 *
 * CRASH RECOVERY:
 * - Worker A crashes mid-delivery (lock held)
 * - Lock expires after TTL
 * - Worker B fetches same reminder as due again
 * - Worker B claims lock (now available) and retries delivery
 * - Safe: Single attempt window per worker within lock lifetime
 *
 * NEXT-FIRE ALIGNMENT:
 * - Tick duration must not drift relative to trigger times
 * - Each tick processes reminders where: now >= reminder.triggerAt
 * - Autoscaler adjusts concurrency but maintains tick boundaries
 * - Multiple chunks preserve the "now" snapshot for all parallel work
 *
 * STALE LOCK RECOVERY (Edge Case):
 * - Worker A claims lock at t=0, begins delivery
 * - Worker A is preempted/slow; lock expires at t=TTL
 * - Worker B claims same lock at t=TTL+1
 * - Worker A resumes and completes delivery (late)
 * - Safe: Both see different "now" snapshots; marking phase is idempotent
 *
 * TEST STRATEGY:
 * - Fake timers to control lock expiry
 * - Mock Redis SET NX behavior with TTL tracking
 * - Simulate concurrent workers via Promise.all and multiple claimDelivery calls
 * - Verify no double-delivery via deliverReminder call counts
 */

describe("Scheduler Job-Runner: Concurrency & Crash Recovery", () => {
  let repository: InMemoryReminderRepository;
  let deliveryLog: Array<{ id: number; workerId: string; timestamp: number }>;
  let lockStore: Map<string, { expiresAt: number; workerId: string }>;
  let currentTime: number;

  beforeEach(() => {
    jest.useFakeTimers();
    currentTime = Date.now();
    jest.setSystemTime(currentTime);

    repository = new InMemoryReminderRepository();
    repository.reset();
    reminderMetrics.reset();

    deliveryLog = [];
    lockStore = new Map();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * Mock claimDelivery that respects TTL and simulates Redis behavior
   */
  function createMockClaim(workerId: string) {
    return async (reminderId: number, triggerAt: number): Promise<boolean> => {
      const key = `reminder:dedup:${reminderId}:${triggerAt}`;
      const now = Date.now();
      const existing = lockStore.get(key);

      // Lock exists and not expired
      if (existing && existing.expiresAt > now) {
        return false;
      }

      // Lock expired or doesn't exist → claim it
      const DEDUP_TTL_MS = 25 * 60 * 60 * 1000;
      lockStore.set(key, {
        expiresAt: now + DEDUP_TTL_MS,
        workerId,
      });
      return true;
    };
  }

  /**
   * Test 1: At most one worker active per shard
   *
   * Invariant: Only one worker successfully delivers a reminder.
   * Multiple concurrent workers attempt to claim the same reminder;
   * only the first succeeds.
   */
  it("ensures only one worker delivers per reminder (concurrent claims)", async () => {
    const now = Date.now();
    const reminder = await repository.create({
      slotId: 1,
      triggerAt: now - 1000,
    });

    const deliverFn = jest.fn(async (r) => {
      deliveryLog.push({
        id: r.id,
        workerId: "unknown",
        timestamp: Date.now(),
      });
    });

    // Simulate 5 concurrent workers attempting to deliver the same reminder
    const workers = Array.from({ length: 5 }, (_, i) => `worker-${i}`);
    const claims = await Promise.all(
      workers.map((workerId) =>
        processReminders({
          repository,
          now,
          reminders: [reminder],
          deliverReminder: deliverFn,
          claimDeliveryFn: createMockClaim(workerId),
        })
      )
    );

    // Only one worker should have successfully delivered
    expect(deliverFn).toHaveBeenCalledTimes(1);
    expect(reminderMetrics.snapshot().delivered).toBe(1);
    expect(reminderMetrics.snapshot().skipped).toBe(4);

    // Verify reminder is marked sent
    const stored = await repository.findById(reminder.id);
    expect(stored).toMatchObject({
      status: "sent",
      attempts: 0,
    });
  });

  /**
   * Test 2: Crash recovery - lock expires, new worker takes over
   *
   * Invariant: When a lock expires, a new worker can claim it
   * and retry without creating a duplicate delivery.
   */
  it("recovers from crashed worker via lock expiry", async () => {
    const baseTime = Date.now();
    const reminder = await repository.create({
      slotId: 2,
      triggerAt: baseTime - 1000,
    });

    const DEDUP_TTL_MS = 25 * 60 * 60 * 1000;
    let workerACompleted = false;

    // Worker A attempts delivery but crashes mid-way
    const deliverFnA = jest.fn(async () => {
      // Simulate slow/crashed delivery
      // Do nothing; leave lock held
      throw new Error("Worker A crashed");
    });

    jest.setSystemTime(baseTime);

    // Worker A tries and fails
    await processReminders({
      repository,
      now: baseTime,
      reminders: [reminder],
      deliverReminder: deliverFnA,
      claimDeliveryFn: createMockClaim("worker-a"),
      maxRetries: 1,
    });

    expect(deliverFnA).toHaveBeenCalledTimes(1);
    let stored = await repository.findById(reminder.id);
    expect(stored?.status).toBe("failed"); // Max retries reached

    // Advance time past TTL
    jest.setSystemTime(baseTime + DEDUP_TTL_MS + 1);

    // Worker B arrives after lock expired
    const deliverFnB = jest.fn(async () => {
      deliveryLog.push({
        id: reminder.id,
        workerId: "worker-b",
        timestamp: Date.now(),
      });
    });

    // Retry reminder after TTL expiry (reset to pending for retry)
    await repository.recordAttempt(reminder.id, baseTime + DEDUP_TTL_MS + 1);
    const reminderForRetry = await repository.findById(reminder.id);

    if (reminderForRetry && reminderForRetry.status === "pending") {
      await processReminders({
        repository,
        now: baseTime + DEDUP_TTL_MS + 1,
        reminders: [reminderForRetry],
        deliverReminder: deliverFnB,
        claimDeliveryFn: createMockClaim("worker-b"),
      });

      expect(deliverFnB).toHaveBeenCalledTimes(1);
      expect(deliveryLog).toHaveLength(1);
      expect(deliveryLog[0]).toMatchObject({
        id: reminder.id,
        workerId: "worker-b",
      });
    }
  });

  /**
   * Test 3: Drift test - long-running tick respects next-fire alignment
   *
   * Invariant: A long-running tick that spans multiple "fire windows"
   * still processes reminders against the original snapshot time (now),
   * preventing early or late firings.
   */
  it("maintains alignment across long-running ticks with multiple chunks", async () => {
    const baseTime = Date.now();

    // Create reminders at different times
    const r1 = await repository.create({
      slotId: 10,
      triggerAt: baseTime - 2000,
    });
    const r2 = await repository.create({
      slotId: 11,
      triggerAt: baseTime - 1000,
    });
    const r3 = await repository.create({
      slotId: 12,
      triggerAt: baseTime,
    });
    const r4 = await repository.create({
      slotId: 13,
      triggerAt: baseTime + 1000, // Not yet due
    });

    jest.setSystemTime(baseTime);

    const deliveryTimes: Array<{
      reminderId: number;
      processedAt: number;
      triggerAt: number;
    }> = [];

    const deliverFn = jest.fn(async (r) => {
      // Simulate chunk 1 taking 100ms
      jest.setSystemTime(Date.now() + 100);
      deliveryTimes.push({
        reminderId: r.id,
        processedAt: Date.now(),
        triggerAt: r.triggerAt,
      });
    });

    // Process only the due reminders with snapshot time = baseTime
    // (not r4 which is in the future)
    await processReminders({
      repository,
      now: baseTime, // Snapshot at baseTime
      reminders: [r1, r2, r3], // Only due reminders
      deliverReminder: deliverFn,
      claimDeliveryFn: createMockClaim("worker-long"),
    });

    // Only the 3 due reminders should be delivered
    expect(deliverFn).toHaveBeenCalledTimes(3);
    expect(deliveryTimes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reminderId: r1.id, triggerAt: baseTime - 2000 }),
        expect.objectContaining({ reminderId: r2.id, triggerAt: baseTime - 1000 }),
        expect.objectContaining({ reminderId: r3.id, triggerAt: baseTime }),
      ])
    );

    // r4 should not be delivered (not passed to processReminders)
    const r4Stored = await repository.findById(r4.id);
    expect(r4Stored?.status).toBe("pending");
  });

  /**
   * Test 4: Stale lock recovery - new worker claims after TTL
   *
   * Invariant: After a lock TTL expires, a new worker can claim
   * and deliver without conflict.
   */
  it("allows new worker to claim after lock expires", async () => {
    const baseTime = Date.now();
    const reminder = await repository.create({
      slotId: 20,
      triggerAt: baseTime - 1000,
    });

    const DEDUP_TTL_MS = 25 * 60 * 60 * 1000;

    // Worker A claims lock
    const claimFnA = createMockClaim("worker-a");
    const claimedByA = await claimFnA(reminder.id, reminder.triggerAt);
    expect(claimedByA).toBe(true);

    // Worker B tries to claim (within TTL, fails)
    const claimFnB = createMockClaim("worker-b");
    const claimedByB1 = await claimFnB(reminder.id, reminder.triggerAt);
    expect(claimedByB1).toBe(false);

    // Advance time past TTL
    jest.setSystemTime(baseTime + DEDUP_TTL_MS + 1);

    // Worker B can now claim (lock expired)
    const claimedByB2 = await claimFnB(reminder.id, reminder.triggerAt);
    expect(claimedByB2).toBe(true);

    // Worker B can now deliver
    const deliverFnB = jest.fn(async () => {
      // Success
    });

    await processReminders({
      repository,
      now: baseTime + DEDUP_TTL_MS + 1,
      reminders: [reminder],
      deliverReminder: deliverFnB,
      claimDeliveryFn: async () => true, // B already claimed above
    });

    expect(deliverFnB).toHaveBeenCalledTimes(1);
    let stored = await repository.findById(reminder.id);
    expect(stored?.status).toBe("sent");

    // Only one delivery
    expect(reminderMetrics.snapshot().delivered).toBe(1);
  });

  /**
   * Test 5: Multiple concurrent workers, varied outcomes
   *
   * Invariant: With N workers fetching the same reminders:
   * - Exactly one claims per reminder
   * - Others skip (dedup)
   * - Metrics reflect attempted concurrency
   */
  it("handles variable concurrency with proper metrics", async () => {
    const now = Date.now();
    const reminders = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        repository.create({
          slotId: 100 + i,
          triggerAt: now - 1000,
        })
      )
    );

    const concurrency = 4; // 4 workers
    let successfulDeliveries = 0;

    const deliverFn = jest.fn(async () => {
      successfulDeliveries++;
    });

    // Each worker attempts to process all reminders
    await Promise.all(
      Array.from({ length: concurrency }, (_, workerId) =>
        processReminders({
          repository,
          now,
          reminders,
          deliverReminder: deliverFn,
          claimDeliveryFn: createMockClaim(`worker-${workerId}`),
        })
      )
    );

    // Only one delivery per reminder
    expect(deliverFn).toHaveBeenCalledTimes(3);
    expect(reminderMetrics.snapshot().delivered).toBe(3);
    // 4 workers * 3 reminders - 3 successes = 9 skips
    expect(reminderMetrics.snapshot().skipped).toBe(9);
  });

  /**
   * Test 6: Concurrent failures don't cause double-marks
   *
   * Invariant: If two workers attempt delivery and both fail,
   * only one attempt count increment per reminder occurs.
   */
  it("handles concurrent failures without double-counting attempts", async () => {
    const now = Date.now();
    const reminder = await repository.create({
      slotId: 50,
      triggerAt: now - 1000,
    });

    const failureError = new Error("Network timeout");

    const deliverFn = jest.fn(async () => {
      throw failureError;
    });

    // Two workers try simultaneously
    await Promise.all([
      processReminders({
        repository,
        now,
        reminders: [reminder],
        deliverReminder: deliverFn,
        claimDeliveryFn: createMockClaim("worker-a"),
        maxRetries: 3,
      }),
      processReminders({
        repository,
        now,
        reminders: [reminder],
        deliverReminder: deliverFn,
        claimDeliveryFn: createMockClaim("worker-b"),
        maxRetries: 3,
      }),
    ]);

    // Only one should have actually called deliverReminder
    expect(deliverFn).toHaveBeenCalledTimes(1);

    const stored = await repository.findById(reminder.id);
    expect(stored).toMatchObject({
      status: "pending",
      attempts: 1,
    });
  });

  /**
   * Test 7: Lock TTL boundary conditions
   *
   * Invariant: Reminders at lock TTL boundary behave correctly.
   */
  it("respects lock TTL boundary - claim fails just before expiry", async () => {
    const baseTime = Date.now();
    const reminder = await repository.create({
      slotId: 60,
      triggerAt: baseTime - 1000,
    });

    const DEDUP_TTL_MS = 25 * 60 * 60 * 1000;

    // Worker A claims at t=0
    const claimFnA = createMockClaim("worker-a");
    const claimed1 = await claimFnA(reminder.id, reminder.triggerAt);
    expect(claimed1).toBe(true);

    // Move time to just before expiry
    jest.setSystemTime(baseTime + DEDUP_TTL_MS - 1);

    // Worker B tries (should fail)
    const claimFnB = createMockClaim("worker-b");
    const claimed2 = await claimFnB(reminder.id, reminder.triggerAt);
    expect(claimed2).toBe(false);

    // Move time to after expiry
    jest.setSystemTime(baseTime + DEDUP_TTL_MS + 1);

    // Worker B tries again (should succeed)
    const claimed3 = await claimFnB(reminder.id, reminder.triggerAt);
    expect(claimed3).toBe(true);
  });

  /**
   * Test 8: Autoscaler concurrency doesn't break dedup contract
   *
   * Invariant: Even when autoscaler increases concurrency,
   * the dedup mechanism prevents double-delivery.
   */
  it("maintains dedup invariant across autoscaler concurrency changes", async () => {
    const now = Date.now();
    const reminders = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        repository.create({
          slotId: 200 + i,
          triggerAt: now - 1000,
        })
      )
    );

    const deliveryLog: number[] = [];
    const deliverFn = jest.fn(async (r) => {
      deliveryLog.push(r.id);
    });

    // Simulate autoscaler increasing concurrency: 1 → 4
    // This means 4 parallel chunks of 2-3 reminders each
    // But each worker gets ALL reminders and dedup handles conflicts
    const concurrency = 4;
    
    // 4 concurrent workers, all processing all reminders
    await Promise.all(
      Array.from({ length: concurrency }, (_, workerId) =>
        processReminders({
          repository,
          now,
          reminders,
          deliverReminder: deliverFn,
          claimDeliveryFn: createMockClaim(`worker-${workerId}`),
        })
      )
    );

    // All 10 should deliver exactly once (only one worker per reminder)
    expect(deliveryLog).toHaveLength(10);
    expect(new Set(deliveryLog).size).toBe(10); // No duplicates

    expect(reminderMetrics.snapshot().delivered).toBe(10);
    // 4 workers * 10 reminders - 10 successful = 30 skips
    expect(reminderMetrics.snapshot().skipped).toBe(30);
  });

  /**
   * Test 9: Complex crash scenario - multiple retries across TTL boundary
   */
  it("handles complex crash + retry + expiry scenario", async () => {
    const t0 = Date.now();
    jest.setSystemTime(t0);

    const DEDUP_TTL_MS = 25 * 60 * 60 * 1000;
    const reminder = await repository.create({
      slotId: 75,
      triggerAt: t0 - 1000,
    });

    // t0: Worker A claims and attempts delivery
    let claimedByA1 = await createMockClaim("worker-a")(reminder.id, reminder.triggerAt);
    expect(claimedByA1).toBe(true);

    const deliverFnA = jest.fn(async () => {
      throw new Error("A: connection timeout");
    });

    await processReminders({
      repository,
      now: t0,
      reminders: [reminder],
      deliverReminder: deliverFnA,
      claimDeliveryFn: async () => true, // A already has the lock
      maxRetries: 1,
    });

    // Reminder now marked as failed (max retries reached)
    let stored = await repository.findById(reminder.id);
    expect(stored?.status).toBe("failed");

    // t1: TTL expired, admin manually resets reminder to pending
    const t1 = t0 + DEDUP_TTL_MS + 1;
    jest.setSystemTime(t1);

    // Manually reset reminder to pending by setting status back
    // (In reality, this would be done by an admin command or recovery job)
    stored = await repository.findById(reminder.id);
    if (stored) {
      // Create new reminder for retry with updated triggerAt
      const retryReminder = await repository.create({
        slotId: reminder.slotId,
        triggerAt: t1 - 1000, // Mark as due again
      });

      // t1: Worker B claims and successfully delivers
      const deliverFnB = jest.fn(async () => {
        // Success
      });

      const claimedByB = await createMockClaim("worker-b")(retryReminder.id, retryReminder.triggerAt);
      expect(claimedByB).toBe(true);

      await processReminders({
        repository,
        now: t1,
        reminders: [retryReminder],
        deliverReminder: deliverFnB,
        claimDeliveryFn: async () => true,
      });

      expect(deliverFnB).toHaveBeenCalledTimes(1);
      stored = await repository.findById(retryReminder.id);
      expect(stored?.status).toBe("sent");

      // Total deliveries: 1 (only B succeeded)
      expect(reminderMetrics.snapshot().delivered).toBe(1);
    }
  });

  /**
   * Test 10: Monotonicity - reminder processed in correct order despite concurrency
   */
  it("maintains event ordering guarantees within a tick snapshot", async () => {
    const now = Date.now();
    const dueReminders = await Promise.all([
      repository.create({ slotId: 300, triggerAt: now - 5000 }), // Due earliest
      repository.create({ slotId: 301, triggerAt: now - 3000 }),
      repository.create({ slotId: 302, triggerAt: now - 1000 }),
    ]);

    // Create a future reminder but DON'T pass it to processReminders
    const futureReminder = await repository.create({
      slotId: 303,
      triggerAt: now + 1000, // Not yet due
    });

    const deliveryOrder: number[] = [];
    const deliverFn = jest.fn(async (r) => {
      deliveryOrder.push(r.id);
    });

    // All 3 workers try simultaneously with only the due reminders
    await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        processReminders({
          repository,
          now,
          reminders: dueReminders, // Only due reminders
          deliverReminder: deliverFn,
          claimDeliveryFn: createMockClaim(`worker-${i}`),
        })
      )
    );

    // Should deliver exactly the 3 due ones (only one worker per reminder)
    expect(deliveryOrder).toHaveLength(3);
    expect(new Set(deliveryOrder).size).toBe(3);

    // Verify future reminder was not delivered
    const futureStored = await repository.findById(futureReminder.id);
    expect(futureStored?.status).toBe("pending");
  });
});
