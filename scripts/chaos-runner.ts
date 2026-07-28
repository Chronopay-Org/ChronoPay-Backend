import * as fs from 'fs';
import * as path from 'path';

export interface ScenarioSpec {
  id: string;
  description: string;
  target: string;
  preCheck: () => Promise<boolean>;
  run: () => Promise<void>;
  postCheck: () => Promise<boolean>;
}

export interface ScenarioOutcome {
  id: string;
  timestamp: string;
  target: string;
  status: 'SUCCESS' | 'PRE_CHECK_FAILED' | 'RUN_FAILED' | 'POST_CHECK_FAILED' | 'ABORTED' | 'MISSING_TARGET';
  durationMs: number;
  error?: string;
}

const OUTCOMES_FILE = path.resolve(process.cwd(), 'ops/chaos/outcomes.json');

export async function persistOutcome(outcome: ScenarioOutcome): Promise<void> {
  let outcomes: ScenarioOutcome[] = [];
  try {
    if (fs.existsSync(OUTCOMES_FILE)) {
      const data = fs.readFileSync(OUTCOMES_FILE, 'utf-8');
      outcomes = JSON.parse(data);
    }
  } catch (err) {
    // ignore read error
  }
  
  outcomes.push(outcome);
  
  // ensure dir exists
  const dir = path.dirname(OUTCOMES_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(OUTCOMES_FILE, JSON.stringify(outcomes, null, 2), 'utf-8');
}

export async function runScenario(spec: ScenarioSpec): Promise<ScenarioOutcome> {
  const start = Date.now();
  let outcome: ScenarioOutcome = {
    id: spec?.id || 'unknown',
    timestamp: new Date().toISOString(),
    target: spec?.target || 'unknown',
    status: 'SUCCESS',
    durationMs: 0
  };

  try {
    if (!spec.target || spec.target.trim() === '') {
      outcome.status = 'MISSING_TARGET';
      outcome.error = 'Missing or empty target';
      outcome.durationMs = Date.now() - start;
      await persistOutcome(outcome);
      return outcome;
    }

    // Pre-check
    let preCheckPassed = false;
    try {
      preCheckPassed = await spec.preCheck();
    } catch (err: any) {
      outcome.status = 'PRE_CHECK_FAILED';
      outcome.error = `Pre-check threw error: ${err.message}`;
      outcome.durationMs = Date.now() - start;
      await persistOutcome(outcome);
      return outcome;
    }

    if (!preCheckPassed) {
      outcome.status = 'PRE_CHECK_FAILED';
      outcome.error = 'Pre-check failed or returned false. Aborting scenario.';
      outcome.durationMs = Date.now() - start;
      await persistOutcome(outcome);
      return outcome;
    }

    // Run
    try {
      await spec.run();
    } catch (err: any) {
      outcome.status = 'RUN_FAILED';
      outcome.error = `Run threw error: ${err.message}`;
      outcome.durationMs = Date.now() - start;
      await persistOutcome(outcome);
      return outcome;
    }

    // Post-check
    let postCheckPassed = false;
    try {
      postCheckPassed = await spec.postCheck();
    } catch (err: any) {
      outcome.status = 'POST_CHECK_FAILED';
      outcome.error = `Post-check threw error: ${err.message}`;
      outcome.durationMs = Date.now() - start;
      await persistOutcome(outcome);
      return outcome;
    }

    if (!postCheckPassed) {
      outcome.status = 'POST_CHECK_FAILED';
      outcome.error = 'Post-check failed or returned false.';
    }

  } catch (err: any) {
    outcome.status = 'ABORTED';
    outcome.error = `Unexpected error: ${err.message}`;
  }

  outcome.durationMs = Date.now() - start;
  await persistOutcome(outcome);
  return outcome;
}
