// Reset the Redis test double once per test file so keys don't leak across suites.
import { resetRedisClient } from "../../utils/redis.js";

beforeAll(() => {
  resetRedisClient();
});
