#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_JSON_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function detectDiffClass(tag) {
  const normalized = tag.toLowerCase();
  if (normalized.includes("nonbreaking") || normalized.includes("non-breaking")) {
    return "patch";
  }
  if (normalized.includes("breaking") || normalized.includes("major")) {
    return "major";
  }
  if (normalized.includes("minor")) {
    return "minor";
  }
  return "patch";
}

export function computeNextVersion(currentVersion, diffClass) {
  const [major, minor, patch] = currentVersion.split(".").map(Number);
  if ([major, minor, patch].some((value) => Number.isNaN(value))) {
    throw new Error(`Invalid semantic version: ${currentVersion}`);
  }

  switch (diffClass) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}

export function isTwoFactorChallengeError(output) {
  return /eotp|one-time password|otp/i.test(output);
}

export function isDuplicateVersionError(output) {
  return /package already exists|already published|version.*exists/i.test(output);
}

export function getCurrentVersion(packageJsonPath = path.resolve(process.cwd(), "package.json")) {
  if (!existsSync(packageJsonPath)) {
    throw new Error(`Package manifest not found at ${packageJsonPath}`);
  }

  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return manifest.version;
}

export function bumpPackageVersion(packageJsonPath, version) {
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  manifest.version = version;
  writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.version;
}

export function resolveReleaseVersion(tag, currentVersion) {
  const diffClass = detectDiffClass(tag);
  return computeNextVersion(currentVersion, diffClass);
}

export function runNpmPublish(version, cwd = process.cwd(), dryRun = false) {
  const args = ["publish", "--access", "public", "--provenance", "--tag", "latest"];
  if (dryRun) {
    args.push("--dry-run");
  }

  const output = execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return output.trim() || `Published ${version}`;
}

export function writeReleaseMetadata(version, tag, outputPath = path.resolve(process.cwd(), ".release-metadata.json")) {
  const payload = {
    version,
    tag,
    publishedAt: new Date().toISOString(),
  };
  writeFileSync(outputPath, JSON.stringify(payload, null, 2));
  return payload;
}

function parseArgs(argv) {
  const args = { dryRun: false, tag: process.env.GITHUB_REF_NAME || process.env.npm_config_tag || "" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") {
      args.dryRun = true;
    } else if (token === "--tag") {
      args.tag = argv[index + 1] || "";
      index += 1;
    } else if (token === "--help") {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  console.log("Usage: node scripts/release-sdk.js [--dry-run] [--tag <tag>]");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!args.tag) {
    throw new Error("No release tag provided. Pass --tag or set GITHUB_REF_NAME.");
  }

  const packageJsonPath = PACKAGE_JSON_PATH;
  const currentVersion = getCurrentVersion(packageJsonPath);
  const nextVersion = resolveReleaseVersion(args.tag, currentVersion);
  console.log(`Resolved release version ${nextVersion} from tag ${args.tag}`);

  if (!args.dryRun) {
    const backupVersion = currentVersion;
    try {
      bumpPackageVersion(packageJsonPath, nextVersion);
      runNpmPublish(nextVersion, path.resolve(__dirname, ".."), false);
      writeReleaseMetadata(nextVersion, args.tag, path.resolve(__dirname, "../.release-metadata.json"));
      console.log(`Published SDK ${nextVersion} to npm`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTwoFactorChallengeError(message)) {
        bumpPackageVersion(packageJsonPath, backupVersion);
        console.error("npm publish was blocked by 2FA. Re-run with a valid OTP token.");
        process.exitCode = 2;
        return;
      }
      if (isDuplicateVersionError(message)) {
        bumpPackageVersion(packageJsonPath, backupVersion);
        console.warn(`Version ${nextVersion} already exists on npm; skipping publish.`);
        process.exitCode = 0;
        return;
      }
      bumpPackageVersion(packageJsonPath, backupVersion);
      throw error;
    }
  } else {
    console.log(`[dry-run] npm publish would target version ${nextVersion}`);
    writeReleaseMetadata(nextVersion, args.tag, path.resolve(__dirname, "../.release-metadata.json"));
  }
}

const entrypointPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entrypointPath && path.resolve(fileURLToPath(import.meta.url)) === entrypointPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
