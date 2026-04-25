export const FEATURE_FLAG_NAMES = ["CREATE_SLOT", "CREATE_BOOKING_INTENT"] as const;

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
