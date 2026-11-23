import * as fs from 'fs';
import * as path from 'path';
import { jest } from '@jest/globals';
import { runScenario, persistOutcome, ScenarioOutcome, ScenarioSpec } from '../chaos-runner.js';

const OUTCOMES_FILE = path.resolve(process.cwd(), 'ops/chaos/outcomes.json');

describe('Chaos Scenario Runner', () => {
  beforeEach(() => {
    // Reset outcomes file before each test
    if (fs.existsSync(OUTCOMES_FILE)) {
      fs.unlinkSync(OUTCOMES_FILE);
    }
    // Create ops/chaos if not exists
    const dir = path.dirname(OUTCOMES_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up
    if (fs.existsSync(OUTCOMES_FILE)) {
      fs.unlinkSync(OUTCOMES_FILE);
    }
  });

  it('aborts on pre-check failure (returns false)', async () => {
    const spec: ScenarioSpec = {
      id: 'test-1',
      description: 'Pre-check fail',
      target: 'service-a',
      preCheck: async () => false,
      run: jest.fn().mockResolvedValue(undefined),
      postCheck: async () => true,
    };

    const outcome = await runScenario(spec);

    expect(outcome.status).toBe('PRE_CHECK_FAILED');
    expect(outcome.error).toContain('failed or returned false');
    expect(spec.run).not.toHaveBeenCalled();

    const saved = JSON.parse(fs.readFileSync(OUTCOMES_FILE, 'utf-8'));
    expect(saved).toHaveLength(1);
    expect(saved[0].status).toBe('PRE_CHECK_FAILED');
  });

  it('aborts on pre-check failure (throws error)', async () => {
    const spec: ScenarioSpec = {
      id: 'test-1-flake',
      description: 'Pre-check flake/error',
      target: 'service-a',
      preCheck: async () => { throw new Error('flake error') },
      run: jest.fn().mockResolvedValue(undefined),
      postCheck: async () => true,
    };

    const outcome = await runScenario(spec);

    expect(outcome.status).toBe('PRE_CHECK_FAILED');
    expect(outcome.error).toContain('flake error');
    expect(spec.run).not.toHaveBeenCalled();
  });

  it('handles missing target', async () => {
    const spec: ScenarioSpec = {
      id: 'test-2',
      description: 'Missing target',
      target: '',
      preCheck: jest.fn().mockResolvedValue(true),
      run: jest.fn().mockResolvedValue(undefined),
      postCheck: async () => true,
    };

    const outcome = await runScenario(spec);

    expect(outcome.status).toBe('MISSING_TARGET');
    expect(spec.preCheck).not.toHaveBeenCalled();
    expect(spec.run).not.toHaveBeenCalled();
  });

  it('executes full flow successfully', async () => {
    const runMock = jest.fn().mockResolvedValue(undefined);
    const spec: ScenarioSpec = {
      id: 'test-3',
      description: 'Success',
      target: 'service-b',
      preCheck: async () => true,
      run: runMock,
      postCheck: async () => true,
    };

    const outcome = await runScenario(spec);

    expect(outcome.status).toBe('SUCCESS');
    expect(runMock).toHaveBeenCalled();
    
    const saved = JSON.parse(fs.readFileSync(OUTCOMES_FILE, 'utf-8'));
    expect(saved).toHaveLength(1);
    expect(saved[0].status).toBe('SUCCESS');
  });

  it('handles run failures securely', async () => {
    const spec: ScenarioSpec = {
      id: 'test-4',
      description: 'Run fail',
      target: 'service-c',
      preCheck: async () => true,
      run: async () => { throw new Error('run crash') },
      postCheck: jest.fn().mockResolvedValue(true),
    };

    const outcome = await runScenario(spec);

    expect(outcome.status).toBe('RUN_FAILED');
    expect(outcome.error).toContain('run crash');
    expect(spec.postCheck).not.toHaveBeenCalled();
  });

  it('handles post-check failure (returns false)', async () => {
    const spec: ScenarioSpec = {
      id: 'test-5',
      description: 'Post-check fail',
      target: 'service-d',
      preCheck: async () => true,
      run: async () => {},
      postCheck: async () => false,
    };

    const outcome = await runScenario(spec);

    expect(outcome.status).toBe('POST_CHECK_FAILED');
    expect(outcome.error).toContain('failed or returned false');
  });

  it('handles post-check failure (throws error)', async () => {
    const spec: ScenarioSpec = {
      id: 'test-6',
      description: 'Post-check throw',
      target: 'service-e',
      preCheck: async () => true,
      run: async () => {},
      postCheck: async () => { throw new Error('post check crash') },
    };

    const outcome = await runScenario(spec);

    expect(outcome.status).toBe('POST_CHECK_FAILED');
    expect(outcome.error).toContain('post check crash');
  });

  it('handles unexpected errors', async () => {
    const spec: any = null;

    const outcome = await runScenario(spec);

    expect(outcome.status).toBe('ABORTED');
  });

  it('persistOutcome handles existing invalid file', async () => {
    fs.writeFileSync(OUTCOMES_FILE, 'invalid json');
    const outcome: ScenarioOutcome = {
      id: 'test', target: 't', status: 'SUCCESS', durationMs: 1, timestamp: '1'
    };
    await persistOutcome(outcome);
    
    const saved = JSON.parse(fs.readFileSync(OUTCOMES_FILE, 'utf-8'));
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe('test');
  });
});
