import { PgBookingIntentRepository } from "../pg-booking-intent-repository.js";
import { ConflictError } from "../../../errors/AppError.js";

describe('PgBookingIntentRepository additional edge cases', () => {
  let mockQuery: jest.Mock;
  let repo: PgBookingIntentRepository;

  beforeEach(() => {
    mockQuery = jest.fn();
    repo = new PgBookingIntentRepository(mockQuery as any);
  });

  test('create - throws when required fields are missing (slotId)', async () => {
    const intent: any = {
      professional: 'prof-1',
      customerId: 'cust-1',
      startTime: Date.now(),
      endTime: Date.now() + 1000,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    // The repository will try to use intent.slotId which is undefined and the DB will likely reject.
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('null value'), { code: '23502' }));
    await expect(repo.create(intent)).rejects.toThrow();
  });

  test('create - propagates non‑conflict DB errors', async () => {
    const intent = {
      slotId: 's1',
      professional: 'p1',
      customerId: 'c1',
      startTime: Date.now(),
      endTime: Date.now() + 5000,
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
    };
    const dbError: any = new Error('syntax error');
    dbError.code = '42601';
    mockQuery.mockRejectedValueOnce(dbError);
    await expect(repo.create(intent)).rejects.toBe(dbError);
  });

  test('findById - ensures query parameters order', async () => {
    const row = {
      id: 'id1',
      slot_id: 's1',
      professional_id: 'p1',
      customer_id: 'c1',
      start_time: new Date(0).toISOString(),
      end_time: new Date(1000).toISOString(),
      status: 'pending',
      note: null,
      created_at: new Date().toISOString(),
    };
    mockQuery.mockResolvedValueOnce({ rows: [row] } as any);
    const result = await repo.findById('id1');
    expect(result?.id).toBe('id1');
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1'), ['id1']);
  });
});
