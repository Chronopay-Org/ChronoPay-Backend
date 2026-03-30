export const FEATURE_FLAG_NAMES = ["CREATE_SLOT"] as const;

export type FeatureFlagName = (typeof FEATURE_FLAG_NAMES)[number];

export interface FeatureFlagDefinition {
  envVar: `FF_${string}`;
  description: string;
  defaultEnabled: boolean;
}

export type FeatureFlagState = Record<FeatureFlagName, boolean>;

export interface FeatureFlagAccessor {
  isEnabled: (flag: FeatureFlagName) => boolean;
  list: () => FeatureFlagState;
}
