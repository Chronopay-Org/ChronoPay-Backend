import { BookingIntentService } from '../booking-intent-service';
import { InMemoryBookingIntentRepository } from '../booking-intent-repository';
import { BookingIntentError } from '../booking-intent-error';

describe('BookingIntentService concurrency', () => {
  const slotId = 'slot-123';
  const customerA = 'customer-a';
  const customerB = 'customer-b';

  function makeInput(customerId: string) {
    return {
      slotId,
      customerId,
      amount: 1000,
      currency: 'USD',
    };
  }

  function delayedFxProvider(delayMs: number) {
    return {
      getRate: async (_from: string, _to: string) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return 1;
      },
    };
  }

  it('performs the sequential happy path', async () => {
    const repo = new InMemoryBookingIntentRepository();
    const service = new BookingIntentService(repo, delayedFxProvider(0) as any);

    const intent = await service.createIntent(makeInput(customerA));

    expect(intent).toBeTruthy();
    expect(intent.slotId).toBe(slotId);
    expect(intent.customerId).toBe(customerA);
    expect(await repo.findBySlotId(slotId)).toHaveLength(1);
  });

  it('allows exactly one of two concurrent createIntent calls for the same slot', async () => {
    const repo = new InMemoryBookingIntentRepository();
    // Delayed FX provider forces the event loop to interleave the two calls.
    const service = new BookingIntentService(repo, delayedFxProvider(20)  as any);

    const results = await Promise.allSettled([
      service.createIntent(makeInput(customerA)),
      service.createIntent(makeInput(customerB)),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejection = rejected[0] as PromiseRejectedResult<unknown>;
    expect(rejection.reason).beInstanceOf(BookingIntentError);
    expect((rejection.reason as BookingIntentError).status).toBe(409);

    // Only one active intent for the slot exists.
    const active = await repo.findBySlotId(slotId);
    expect(active).toHaveLength(1);
  });

  it('releases the slot reservation when creation fails after reservation', async () => {
    const repo = new InMemoryBookingIntentRepository();
    const failingFx = {
      getRate: async () => {
        throw new Error('fx unavailable');
      },
    };
    const service = new BookingIntentService(repo, failingFx as any);

    await expect(service.createIntent(makeInput(customerA))).rejects.toThrow();

    // No intent was persisted.
    expect(await repo.findBySlotId(slotId)).toHaveLength(0);

    // The slot is not left reserved: a subsequent create for the same slot
    // by a different customer succeeds.
    const succeedingFx = delayedFxProvider(0);
    const service2 = new BookingIntentService(repo, succeedingFx as any);
    const intent = await service2.createIntent(makeInput(customerB));
    expect(intent.customerId).toBe(customerB);
    expect(await repo.findBySlotId(slotId)).toHaveLength(1);
  });
});
