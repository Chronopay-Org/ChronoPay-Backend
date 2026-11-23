import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { buildCycloneDxArgs, generateSbom, SbomGenerationError, DEFAULT_SBOM_OUTPUT_FILE } from "../generate-sbom";

const mockedExec = jest.fn();

describe("buildCycloneDxArgs", () => {
  it("omits devDependencies by default", () => {
    const args = buildCycloneDxArgs();
    expect(args).toContain("--omit");
    expect(args).toContain("dev");
    expect(args).toContain(DEFAULT_SBOM_OUTPUT_FILE);
  });

  it("includes devDependencies when explicitly requested", () => {
    const args = buildCycloneDxArgs({ includeDev: true });
    expect(args).not.toContain("--omit");
  });

  it("respects a custom output file", () => {
    const args = buildCycloneDxArgs({ outputFile: "custom.json" });
    expect(args).toContain("custom.json");
    expect(args).not.toContain(DEFAULT_SBOM_OUTPUT_FILE);
  });
});

describe("generateSbom", () => {
  beforeEach(() => {
    mockedExec.mockReset();
  });

  it("returns the output file path on success", () => {
    mockedExec.mockReturnValue(Buffer.from(""));
    const result = generateSbom({ outputFile: "out.json", execImpl: mockedExec as unknown as typeof import("node:child_process").execFileSync });
    expect(result).toBe("out.json");
    expect(mockedExec).toHaveBeenCalledWith(
      "npx",
      expect.arrayContaining(["@cyclonedx/cyclonedx-npm"]),
      expect.any(Object),
    );
  });

  it("raises a clear error for an unresolved dependency in the lockfile", () => {
    mockedExec.mockImplementation(() => {
      const err: any = new Error("Command failed");
      err.stderr = Buffer.from("Error: could not resolve dependency @foo/bar");
      throw err;
    });
    const execImpl = mockedExec as unknown as typeof import("node:child_process").execFileSync;

    expect(() => generateSbom({ execImpl })).toThrow(SbomGenerationError);
    try {
      generateSbom({ execImpl });
    } catch (err) {
      expect(err).toBeInstanceOf(SbomGenerationError);
      expect((err as SbomGenerationError).message).toMatch(/unresolved or missing dependency/i);
    }
  });

  it("wraps other failures with a generic message", () => {
    mockedExec.mockImplementation(() => {
      const err: any = new Error("spawn npx ENOENT");
      err.stderr = Buffer.from("");
      throw err;
    });
    const execImpl = mockedExec as unknown as typeof import("node:child_process").execFileSync;

    expect(() => generateSbom({ execImpl })).toThrow(/SBOM generation failed/);
  });
});
