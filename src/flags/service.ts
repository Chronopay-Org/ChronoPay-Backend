import { FEATURE_FLAGS } from "./registry.js";
import {
  FEATURE_FLAG_NAMES,
  type FeatureFlagAccessor,
  type FeatureFlagName,
  type FeatureFlagState,
} from "./types.js";

const TRUE_VALUES = new Set(["1", "true", "on", "yes"]);
const FALSE_VALUES = new Set(["0", "false", "off", "no"]);

let activeFeatureFlags: FeatureFlagState = resolveFeatureFlags(process.env);

function parseFeatureFlagValue(value: string, envVar: string): boolean {
  const normalized = value.trim().toLowerCase();

  if (TRUE_VALUES.has(normalized)) {
    return true;
  }

  if (FALSE_VALUES.has(normalized)) {
    return false;
  }

  throw new Error(
    `Invalid value for ${envVar}: "${value}". Supported values are true/false, 1/0, on/off, yes/no.`,
  );
}

export function resolveFeatureFlags(
  env: NodeJS.ProcessEnv = process.env,
): FeatureFlagState {
  const state = {} as FeatureFlagState;

  for (const flagName of FEATURE_FLAG_NAMES) {
    const definition = FEATURE_FLAGS[flagName];
    const rawValue = env[definition.envVar];

    state[flagName] =
      rawValue === undefined
        ? definition.defaultEnabled
        : parseFeatureFlagValue(rawValue, definition.envVar);
  }

  return state;
}

export function setFeatureFlagsFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  activeFeatureFlags = resolveFeatureFlags(env);
}

function assertKnownFlag(flag: string): asserts flag is FeatureFlagName {
  if (!FEATURE_FLAG_NAMES.includes(flag as FeatureFlagName)) {
    throw new Error(`Unknown feature flag: ${flag}`);
  }
}

export function isFeatureEnabled(flag: FeatureFlagName): boolean {
  assertKnownFlag(flag);
  return activeFeatureFlags[flag];
}

export function getFeatureFlagsSnapshot(): FeatureFlagState {
  return { ...activeFeatureFlags };
}

export function getFeatureFlagAccessor(): FeatureFlagAccessor {
  return {
    isEnabled: (flag: FeatureFlagName): boolean => isFeatureEnabled(flag),
    list: (): FeatureFlagState => getFeatureFlagsSnapshot(),
  };
}

// Validate at startup and fail closed on malformed configuration.
setFeatureFlagsFromEnv(process.env);
