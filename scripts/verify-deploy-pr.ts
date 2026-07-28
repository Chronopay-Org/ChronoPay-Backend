#!/usr/bin/env tsx
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeployType,
  verifyDeployPr,
  VerifyDeployPrOptions,
} from "../ops/soc2ChangeManagement.js";

export interface CliArgs {
  commit?: string;
  pr?: number;
  environment?: string;
  deployType?: DeployType;
  override?: boolean;
  overrideReason?: string;
  ledgerPath?: string;
  json?: boolean;
  help?: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      args.help = true;
    } else if (token === "--commit" || token === "-c") {
      args.commit = argv[i + 1];
      i += 1;
    } else if (token === "--pr" || token === "-p") {
      args.pr = Number.parseInt(argv[i + 1], 10);
      i += 1;
    } else if (token === "--env" || token === "-e") {
      args.environment = argv[i + 1];
      i += 1;
    } else if (token === "--type" || token === "-t") {
      const typeVal = argv[i + 1]?.toUpperCase();
      if (
        typeVal === "STANDARD" ||
        typeVal === "ROLLBACK" ||
        typeVal === "HOTFIX" ||
        typeVal === "TAG_REDEPLOY"
      ) {
        args.deployType = typeVal as DeployType;
      }
      i += 1;
    } else if (token === "--override") {
      args.override = true;
    } else if (token === "--override-reason") {
      args.overrideReason = argv[i + 1];
      i += 1;
    } else if (token === "--ledger-path") {
      args.ledgerPath = argv[i + 1];
      i += 1;
    } else if (token === "--json") {
      args.json = true;
    }
  }
  return args;
}

export function getFallbackCommit(): string {
  if (process.env.GITHUB_SHA) {
    return process.env.GITHUB_SHA;
  }
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function printHelp(): void {
  console.log(`
SOC2 Change-Management Pre-Deploy Verification CLI

Usage:
  npx tsx scripts/verify-deploy-pr.ts [options]

Options:
  -c, --commit <hash>         Git commit SHA to verify (default: GITHUB_SHA or HEAD)
  -p, --pr <number>           Pull request number linked to deploy
  -e, --env <environment>     Target environment (default: production)
  -t, --type <type>           Deploy type: STANDARD | ROLLBACK | HOTFIX | TAG_REDEPLOY (default: STANDARD)
      --override              Enable manual override for urgent emergency deploys
      --override-reason <msg> Mandatory explanation when using --override
      --ledger-path <path>    Custom audit ledger JSON file path
      --json                  Output result in JSON format
  -h, --help                  Show this help text

Exit Codes:
  0 - Deploy approved (PR verified & recorded)
  1 - Deploy blocked or error occurred
  2 - Deploy approved via manual override (alarm emitted)
`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    return 0;
  }

  const commitHash = args.commit || getFallbackCommit();
  if (!commitHash) {
    console.error("Error: Could not resolve git commit SHA. Pass --commit <hash> or set GITHUB_SHA.");
    return 1;
  }

  const prNumber = args.pr || (process.env.PR_NUMBER ? Number.parseInt(process.env.PR_NUMBER, 10) : undefined);
  const environment = args.environment || process.env.DEPLOY_ENV || "production";
  const deployType = args.deployType || (process.env.DEPLOY_TYPE as DeployType) || "STANDARD";
  const override = args.override || process.env.SOC2_OVERRIDE === "true" || false;
  const overrideReason = args.overrideReason || process.env.OVERRIDE_REASON || undefined;
  const ledgerPath = args.ledgerPath || process.env.AUDIT_LEDGER_PATH || undefined;

  const options: VerifyDeployPrOptions = {
    commitHash,
    prNumber,
    environment,
    deployType,
    override,
    overrideReason,
    ledgerPath,
  };

  try {
    const result = await verifyDeployPr(options);

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.approved) {
        if (result.overridden) {
          console.log(`⚠️  DEPLOY OVERRIDDEN: ${result.reason}`);
          console.log(`   Deploy ID: ${result.record.deployId}`);
        } else {
          console.log(`✅ DEPLOY APPROVED: ${result.reason}`);
          console.log(`   Deploy ID: ${result.record.deployId}`);
        }
      } else {
        console.error(`❌ DEPLOY BLOCKED: ${result.reason}`);
        console.error(`   Deploy ID: ${result.record.deployId}`);
      }
    }

    if (result.overridden) {
      return 2;
    }
    return result.approved ? 0 : 1;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (args.json) {
      console.log(JSON.stringify({ approved: false, error: msg }, null, 2));
    } else {
      console.error(`❌ Error during deploy verification: ${msg}`);
    }
    return 1;
  }
}

const entrypointPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entrypointPath && path.resolve(fileURLToPath(import.meta.url)) === entrypointPath) {
  main().then((code) => {
    process.exitCode = code;
  });
}
