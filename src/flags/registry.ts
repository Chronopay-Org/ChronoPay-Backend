import type { FeatureFlagDefinition, FeatureFlagName } from "./types.js";

export const FEATURE_FLAGS: Record<FeatureFlagName, FeatureFlagDefinition> = {
  CREATE_SLOT: {
    envVar: "FF_CREATE_SLOT",
    description: "Enable slot creation via POST /api/v1/slots",
    // Default true preserves current API behavior unless explicitly disabled.
    defaultEnabled: true,
  },
};
