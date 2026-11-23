/**
 * Generates a CycloneDX SBOM for this application's npm dependency tree.
 *
 * Wraps the `@cyclonedx/cyclonedx-npm` CLI so the argument-building logic
 * is unit-testable, and so failures (e.g. an unresolved dependency in
 * package-lock.json) surface a clear, actionable error instead of a raw
 * subprocess stack trace.
 *
 * Usage: tsx scripts/generate-sbom.ts [--include-dev] [--output <file>]
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const isMainModule = typeof process !== "undefined" && process.argv[1] === fileURLToPath(import.meta.url);

export interface GenerateSbomOptions {
  /** Include devDependencies in the SBOM. Defaults to false — matches the
   *  `--omit=dev` convention already used by the `npm audit` CI step. */
  includeDev?: boolean;
  /** Where to write the generated CycloneDX JSON document. */
  outputFile?: string;
  /** Working directory containing package.json / package-lock.json. */
  cwd?: string;
  /** Injectable for tests; defaults to node:child_process's execFileSync. */
  execImpl?: typeof execFileSync;
}

export const DEFAULT_SBOM_OUTPUT_FILE = "sbom.cyclonedx.json";

/**
 * Builds the argument list passed to the `cyclonedx-npm` CLI.
 * Kept as a pure function so tests don't need to spawn a real process.
 */
export function buildCycloneDxArgs(options: GenerateSbomOptions = {}): string[] {
  const outputFile = options.outputFile ?? DEFAULT_SBOM_OUTPUT_FILE;
  const args = ["--output-format", "JSON", "--output-file", outputFile, "--spec-version", "1.5"];

  if (!options.includeDev) {
    args.push("--omit", "dev");
  }

  return args;
}

export class SbomGenerationError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "SbomGenerationError";
  }
}

/**
 * Runs `cyclonedx-npm` and writes the SBOM to disk.
 *
 * Throws `SbomGenerationError` (rather than letting the raw ENOENT / exit
 * code bubble up) when the tool can't resolve the full dependency graph —
 * e.g. package-lock.json is out of sync with package.json — so CI reports
 * a clear cause instead of a bare "process exited with code 1".
 */
export function generateSbom(options: GenerateSbomOptions = {}): string {
  const args = buildCycloneDxArgs(options);
  const outputFile = options.outputFile ?? DEFAULT_SBOM_OUTPUT_FILE;
  const exec = options.execImpl ?? execFileSync;

  try {
    exec("npx", ["--yes", "@cyclonedx/cyclonedx-npm", ...args], {
      cwd: options.cwd ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    return outputFile;
  } catch (err: unknown) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr?: Buffer | string }).stderr ?? "")
        : "";

    const isUnresolvedDependency = /could not resolve|missing package|invalid lockfile/i.test(stderr);

    throw new SbomGenerationError(
      isUnresolvedDependency
        ? "SBOM generation failed: package-lock.json has an unresolved or missing dependency. Run `npm install` to refresh the lockfile and retry."
        : `SBOM generation failed: ${err instanceof Error ? err.message : String(err)}`,
      stderr,
    );
  }
}

if (isMainModule) {
  const includeDev = process.argv.includes("--include-dev");
  const outputArgIndex = process.argv.indexOf("--output");
  const outputFile = outputArgIndex !== -1 ? process.argv[outputArgIndex + 1] : undefined;

  try {
    const written = generateSbom({ includeDev, outputFile });
    console.log(`[sbom] Wrote CycloneDX SBOM to ${written}`);
  } catch (err) {
    console.error(err instanceof SbomGenerationError ? err.message : err);
    if (err instanceof SbomGenerationError && err.stderr) {
      console.error(err.stderr);
    }
    process.exit(1);
  }
}
