import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "@jest/globals";
import { bumpPackageVersion, computeNextVersion, detectDiffClass, isDuplicateVersionError, isTwoFactorChallengeError } from "../release-sdk.js";

describe("SDK release automation", () => {
  it("detects breaking and non-breaking tags", () => {
    expect(detectDiffClass("openapi-breaking-2026-07-28")).toBe("major");
    expect(detectDiffClass("openapi-nonbreaking-2026-07-28")).toBe("patch");
    expect(detectDiffClass("openapi-minor-2026-07-28")).toBe("minor");
    expect(detectDiffClass("openapi-unknown-2026-07-28")).toBe("patch");
  });

  it("computes the next semantic version from the diff class", () => {
    expect(computeNextVersion("1.2.3", "major")).toBe("2.0.0");
    expect(computeNextVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(computeNextVersion("1.2.3", "patch")).toBe("1.2.4");
  });

  it("recognizes npm publish edge cases", () => {
    expect(isTwoFactorChallengeError("npm ERR! code EOTP\nThis operation requires a one-time password")).toBe(true);
    expect(isDuplicateVersionError("npm ERR! code E403\nPackage already exists")).toBe(true);
    expect(isDuplicateVersionError("npm ERR! code E404\nNot found")).toBe(false);
  });

  it("bumps the package version in the manifest", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-release-"));
    const packageJsonPath = path.join(tempDir, "package.json");
    fs.writeFileSync(packageJsonPath, JSON.stringify({ name: "demo", version: "1.0.0" }));

    const updatedVersion = bumpPackageVersion(packageJsonPath, "2.0.0");
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

    expect(updatedVersion).toBe("2.0.0");
    expect(manifest.version).toBe("2.0.0");
  });
});
