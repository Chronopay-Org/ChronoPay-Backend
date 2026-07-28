import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

const spawnMock = jest.fn();

jest.unstable_mockModule('child_process', () => ({
  spawn: spawnMock,
}));

const { verifyImage } = await import('../verify-image.js');

describe('verifyImage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.COSIGN_PUBLIC_KEY;
    delete process.env.COSIGN_PUBLIC_KEY_PREV;
  });

  const mockSpawnResult = (exitCode: number, triggerError = false) => {
    spawnMock.mockImplementation(() => {
      const mockChild = new EventEmitter();
      setTimeout(() => {
        if (triggerError) {
          mockChild.emit('error', new Error('Spawn failed'));
        } else {
          mockChild.emit('close', exitCode);
        }
      }, 10);
      return mockChild as any;
    });
  };

  it('fails when no keys are set', async () => {
    const result = await verifyImage('app:test');
    expect(result).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('verifies successfully with primary key', async () => {
    process.env.COSIGN_PUBLIC_KEY = 'primary-key';
    mockSpawnResult(0);

    const result = await verifyImage('app:test');
    expect(result).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0] as any[];
    expect(args[0]).toBe('cosign');
    expect(args[1]).toContain('verify');
    expect(args[1]).toContain('app:test');
  });

  it('falls back to prev key when primary fails', async () => {
    process.env.COSIGN_PUBLIC_KEY = 'primary-key';
    process.env.COSIGN_PUBLIC_KEY_PREV = 'prev-key';
    
    spawnMock.mockImplementationOnce(() => {
      const mockChild = new EventEmitter();
      setTimeout(() => mockChild.emit('close', 1), 10);
      return mockChild as any;
    }).mockImplementationOnce(() => {
      const mockChild = new EventEmitter();
      setTimeout(() => mockChild.emit('close', 0), 10);
      return mockChild as any;
    });

    const result = await verifyImage('app:test');
    expect(result).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('fails when both keys fail', async () => {
    process.env.COSIGN_PUBLIC_KEY = 'primary-key';
    process.env.COSIGN_PUBLIC_KEY_PREV = 'prev-key';
    mockSpawnResult(1);

    const result = await verifyImage('app:test');
    expect(result).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('verifies successfully with only prev key (mid-rotation)', async () => {
    process.env.COSIGN_PUBLIC_KEY_PREV = 'prev-key';
    mockSpawnResult(0);

    const result = await verifyImage('app:test');
    expect(result).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('handles spawn errors gracefully', async () => {
    process.env.COSIGN_PUBLIC_KEY = 'primary-key';
    mockSpawnResult(1, true);

    const result = await verifyImage('app:test');
    expect(result).toBe(false);
  });
});
