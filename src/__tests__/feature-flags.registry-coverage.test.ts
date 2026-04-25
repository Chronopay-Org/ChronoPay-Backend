import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FEATURE_FLAGS,
  FEATURE_FLAG_NAMES,
  getAllGuardedFeatureRoutes,
} from "../flags/index.js";

describe("feature flag registry coverage", () => {
  it("keeps feature flag names and registry keys aligned", () => {
    expect(Object.keys(FEATURE_FLAGS).sort()).toEqual(
      [...FEATURE_FLAG_NAMES].sort(),
    );
  });

  it("requires deterministic disabled payloads for all guarded routes", () => {
    for (const route of getAllGuardedFeatureRoutes()) {
      expect(route.disabledResponse.status).toBe(503);
      expect(route.disabledResponse.code).toBe("FEATURE_DISABLED");
      expect(route.disabledResponse.error).toBe(
        `Feature ${route.flag} is currently disabled`,
      );
      expect(route.enabledExpectedStatus).toBeGreaterThanOrEqual(200);
      expect(route.enabledExpectedStatus).toBeLessThan(500);
    }
  });

  it("requires docs coverage for every feature flag and guarded route", () => {
    const docsPath = resolve(process.cwd(), "docs/feature-flags.md");
    const docs = readFileSync(docsPath, "utf8");

    for (const flagName of FEATURE_FLAG_NAMES) {
      const definition = FEATURE_FLAGS[flagName];
      expect(docs).toContain(definition.envVar);
      expect(docs).toContain(flagName);

      for (const route of definition.guardedRoutes) {
        expect(docs).toContain(`${route.method} ${route.path}`);
      }
    }
  });
});
