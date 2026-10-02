// Regression tests for slotCache silent failure paths
import { setRedisClient } from "../../src/cache/redisClient.js";
import {
  getCachedSlotsPage,
  getCachedSlots,
  PaginatedSlotsResult,
  Slot,
} from "../../src/cache/slotCache.js";

type MockRedis = {
  get: jest.Mock;
  set: jest.Mock;
  keys: jest.Mock;
  del: jest.Mock;
  ping?: jest.Mock;
  quit?: jest.Mock;
};

function createMockRedis(overrides?: Partial<MockRedis>): MockRedis {
  const mock: MockRedis = {
    get: jest.fn(),
    set: jest.fn(),
    keys: jest.fn(),
    del: jest.fn(),
    ...overrides,
  };
  return mock;
}

describe("slotCache getCachedSlotsPage", () => {
  afterEach(() => {
    // reset client to null after each test
    setRedisClient(null);
  });

  test("returns null when no redis client (environment test)", async () => {
    // No client injected
    const result = await getCachedSlotsPage(1);
    expect(result).toBeNull();
  });

  test("returns null on cache miss (null raw)", async () => {
    const mock = createMockRedis({ get: jest.fn().mockResolvedValue(null) });
    setRedisClient(mock as any);
    const result = await getCachedSlotsPage(2);
    expect(mock.get).toHaveBeenCalledWith("slots:page:2");
    expect(result).toBeNull();
  });

  test("returns parsed object on cache hit", async () => {
    const payload: PaginatedSlotsResult = {
      slots: [{ id: 1, professional: "p1", startTime: "2020-01-01", endTime: "2020-01-02" }],
      page: 1,
      pageSize: 10,
      total: 1,
      totalPages: 1,
    };
    const mock = createMockRedis({
      get: jest.fn().mockResolvedValue(JSON.stringify(payload)),
    });
    setRedisClient(mock as any);
    const result = await getCachedSlotsPage(1);
    expect(result).toEqual(payload);
  });

  test("returns null on redis error", async () => {
    const mock = createMockRedis({ get: jest.fn().mockRejectedValue(new Error("boom")) });
    setRedisClient(mock as any);
    const result = await getCachedSlotsPage(3);
    expect(result).toBeNull();
  });
});

describe("slotCache legacy getCachedSlots", () => {
  afterEach(() => {
    setRedisClient(null);
  });

  test("returns null when client missing", async () => {
    const result = await getCachedSlots();
    expect(result).toBeNull();
  });

  test("returns null on miss", async () => {
    const mock = createMockRedis({ get: jest.fn().mockResolvedValue(null) });
    setRedisClient(mock as any);
    const result = await getCachedSlots();
    expect(result).toBeNull();
  });

  test("returns parsed slots array on hit", async () => {
    const slots: Slot[] = [{ id: 42, professional: "p2", startTime: "t", endTime: "t2" }];
    const mock = createMockRedis({ get: jest.fn().mockResolvedValue(JSON.stringify(slots)) });
    setRedisClient(mock as any);
    const result = await getCachedSlots();
    expect(result).toEqual(slots);
  });
});
