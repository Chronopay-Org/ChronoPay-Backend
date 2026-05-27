import { ContractService } from '../contract.service';
import { ContractExecutionRevertedError, ContractProviderUnavailableError, ContractInvalidRequestError } from '../../errors/contractErrors';
import { RetryPolicy } from '../../utils/retry-policy';

describe('ContractService', () => {
  let contractService: ContractService;
  let mockRetryPolicy: jest.Mocked<RetryPolicy>;

  beforeEach(() => {
    // Mock RetryPolicy to control retry behavior easily if needed,
    // or just use the real one and mock the action.
    mockRetryPolicy = new RetryPolicy() as jest.Mocked<RetryPolicy>;
    // Actually, let's use the real RetryPolicy but with short delays for tests
    const fastRetryPolicy = new RetryPolicy({
      maxRetries: 3,
      initialDelay: 10,
      backoffFactor: 1,
      maxDelay: 10,
      useJitter: false,
    });
    contractService = new ContractService(fastRetryPolicy);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('should retry on transient error', async () => {
    const action = jest.fn()
      .mockRejectedValueOnce(new Error('connection reset')) // Transient
      .mockResolvedValueOnce('success');

    const result = await contractService.call('test call', action);

    expect(result).toBe('success');
    expect(action).toHaveBeenCalledTimes(2);
  });

  test('should not retry on 4xx error (non-transient)', async () => {
    const action = jest.fn().mockRejectedValue(new Error('invalid address')); // 400

    await expect(contractService.call('test call', action))
      .rejects.toThrow(ContractInvalidRequestError);

    expect(action).toHaveBeenCalledTimes(1);
  });

  test('should trip circuit breaker after 5 failures', async () => {
    const action = jest.fn().mockRejectedValue(new Error('service unavailable')); // 503

    // Fail 5 times
    for (let i = 0; i < 5; i++) {
      await expect(contractService.call('test call', action)).rejects.toThrow();
    }
    expect(action).toHaveBeenCalledTimes(5);

    // 6th call should be blocked by circuit breaker
    await expect(contractService.call('test call', action))
      .rejects.toThrow(ContractProviderUnavailableError);
    
    // Action should not be called the 6th time
    expect(action).toHaveBeenCalledTimes(5);
  });

  test('should reset circuit breaker after timeout', async () => {
    const action = jest.fn().mockRejectedValue(new Error('service unavailable'));

    // Trip the breaker
    for (let i = 0; i < 5; i++) {
      await expect(contractService.call('test call', action)).rejects.toThrow();
    }

    // Advance time by 30 seconds
    jest.advanceTimersByTime(30001);

    // Next call should attempt the action again (and fail, but not be blocked by breaker)
    action.mockRejectedValueOnce(new Error('service unavailable'));
    await expect(contractService.call('test call', action)).rejects.toThrow();
    expect(action).toHaveBeenCalledTimes(6);
  });

  test('should reset failure counter on success', async () => {
    const action = jest.fn()
      .mockRejectedValueOnce(new Error('service unavailable'))
      .mockResolvedValueOnce('success');

    // Fail 1 time
    await expect(contractService.call('test call', action)).rejects.toThrow();
    
    // Succeed 1 time
    await contractService.call('test call', action);
    
    // Fail 4 more times (total 5 failures, but not consecutive)
    for (let i = 0; i < 4; i++) {
      await expect(contractService.call('test call', action)).rejects.toThrow();
    }

    // Breaker should NOT be open yet because of the success in between
    action.mockRejectedValueOnce(new Error('service unavailable'));
    await expect(contractService.call('test call', action)).rejects.toThrow();
    expect(action).toHaveBeenCalledTimes(7);
  });
});
