// `CHECKOUT` must stay listed here: `resolveFeatureFlags` iterates this tuple
// to build the active flag state, so a registry entry missing from it is
// silently never resolved (and `requireFeatureFlag` 500s at runtime).
export const FEATURE_FLAG_NAMES = Object.freeze([
  "CREATE_SLOT",
  "CREATE_BOOKING_INTENT",
  "CHECKOUT",
  "SMS_NOTIFICATIONS",
  "SEARCH_LTR_RERANKER",
] as const);

export type FeatureFlagName = (typeof FEATURE_FLAG_NAMES)[number];

export type FeatureFlagGuardedMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";

export interface FeatureFlagDisabledResponse {
  status: number;
  code: "FEATURE_DISABLED";
  error: string;
}

export interface FeatureFlagGuardedRoute {
  method: FeatureFlagGuardedMethod;
  path: `/${string}`;
  description: string;
  enabledExpectedStatus: number;
  disabledResponse: FeatureFlagDisabledResponse;
  requestBody?: Record<string, unknown>;
}

export interface FeatureFlagDefinition {
  envVar: `FF_${string}`;
  description: string;
  defaultEnabled: boolean;
  guardedRoutes: readonly FeatureFlagGuardedRoute[];
}

export type FeatureFlagState = Record<FeatureFlagName, boolean>;

export interface FeatureFlagAccessor {
  isEnabled: (flag: FeatureFlagName) => boolean;
  list: () => FeatureFlagState;
}

/** Deployment environments a rollout schedule can target. Mirrors `NodeEnv`. */
export const ROLLOUT_ENVIRONMENTS = Object.freeze([
  "development",
  "test",
  "production",
] as const);

export type RolloutEnvironment = (typeof ROLLOUT_ENVIRONMENTS)[number];
