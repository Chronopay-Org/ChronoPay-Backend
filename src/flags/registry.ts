import type {
  FeatureFlagDefinition,
  FeatureFlagGuardedRoute,
  FeatureFlagName,
} from "./types.js";

export const FEATURE_FLAGS: Record<FeatureFlagName, FeatureFlagDefinition> = {
  CREATE_SLOT: {
    envVar: "FF_CREATE_SLOT",
    description: "Enable slot creation via POST /api/v1/slots",
    // Default true preserves current API behavior unless explicitly disabled.
    defaultEnabled: true,
    guardedRoutes: [
      {
        method: "POST",
        path: "/api/v1/slots",
        description: "Create a new slot",
        enabledExpectedStatus: 201,
        disabledResponse: {
          status: 503,
          code: "FEATURE_DISABLED",
          error: "Feature CREATE_SLOT is currently disabled",
        },
        requestBody: {
          professional: "alice",
          startTime: 1000,
          endTime: 2000,
        },
      },
    ],
  },
  CREATE_BOOKING_INTENT: {
    envVar: "FF_CREATE_BOOKING_INTENT",
    description: "Enable booking intent creation via POST /api/v1/booking-intents",
    // Default false for safe rollout; enable explicitly in production.
    defaultEnabled: false,
  },
  CHECKOUT: {
    envVar: "FF_CHECKOUT",
    description: "Enable checkout endpoints (POST/GET /api/v1/checkout/sessions). Set to false to kill-switch during incidents.",
    // Default true: checkout is enabled unless explicitly disabled.
    defaultEnabled: true,
  },
};

export interface FeatureFlagGuardedRouteEntry extends FeatureFlagGuardedRoute {
  flag: FeatureFlagName;
}

export function getAllGuardedFeatureRoutes(): FeatureFlagGuardedRouteEntry[] {
  const routes: FeatureFlagGuardedRouteEntry[] = [];

  for (const [flag, definition] of Object.entries(FEATURE_FLAGS) as [
    FeatureFlagName,
    FeatureFlagDefinition,
  ][]) {
    for (const route of definition.guardedRoutes) {
      routes.push({ flag, ...route });
    }
  }

  return routes;
}

export function isGuardedRouteRegistered(
  flag: FeatureFlagName,
  method: string,
  path: string,
): boolean {
  const normalizedMethod = method.toUpperCase();
  const definition = FEATURE_FLAGS[flag];

  return definition.guardedRoutes.some(
    (route) => route.method === normalizedMethod && route.path === path,
  );
}
