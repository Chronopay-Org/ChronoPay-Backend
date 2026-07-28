/**
 * check-wal-integrity.ts
 *
 * CLI entry point for the WAL archive integrity checker.
 *
 * Usage:
 *   tsx scripts/check-wal-integrity.ts --archive /mnt/wal-archive
 *   tsx scripts/check-wal-integrity.ts --archive /mnt/wal-archive --format json
 *   tsx scripts/check-wal-integrity.ts --archive /mnt/wal-archive --min-severity WARNING
 *
 * Exit codes:
 *   0  – archive is healthy
 *   1  – unexpected / fatal error
 *   2  – WARNING alarms only
 *   3  – CRITICAL alarms detected
 */

import { fileURLToPath } from "url";
import {
  WalIntegrityChecker,
} from "../ops/wal/walIntegrityChecker";
import {
  WalAlarmReporter,
  exitCodeForReport,
  formatReportJson,
  formatReportText,
} from "../ops/wal/walAlarmReporter";

// ---------------------------------------------------------------------------
// Argument parsing (no external deps)
// ---------------------------------------------------------------------------

interface CliArgs {
  archive: string;
  format: "text" | "json";
  minSeverity: "INFO" | "WARNING" | "CRITICAL";
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    archive: "",
    format: "text",
    minSeverity: "INFO",
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--archive":
      case "-a":
        args.archive = argv[++i] ?? "";
        break;
      case "--format":
      case "-f":
        {
          const fmt = argv[++i] ?? "";
          if (fmt !== "text" && fmt !== "json") {
            console.error(`Unknown format: ${fmt}. Use 'text' or 'json'.`);
            process.exit(1);
          }
          args.format = fmt;
        }
        break;
      case "--min-severity":
      case "-s":
        {
          const sev = (argv[++i] ?? "").toUpperCase();
          if (sev !== "INFO" && sev !== "WARNING" && sev !== "CRITICAL") {
            console.error(
              `Unknown severity: ${sev}. Use INFO, WARNING, or CRITICAL.`,
            );
            process.exit(1);
          }
          args.minSeverity = sev as CliArgs["minSeverity"];
        }
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        // ignore unknown flags
        break;
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
WAL Archive Integrity Checker

Usage:
  tsx scripts/check-wal-integrity.ts [options]

Options:
  --archive,      -a <path>   Path to WAL archive directory (required)
  --format,       -f <fmt>    Output format: text (default) | json
  --min-severity, -s <sev>    Minimum alarm severity to report: INFO | WARNING | CRITICAL
  --help,         -h          Show this help

Exit codes:
  0   Archive is healthy
  1   Unexpected / fatal error
  2   WARNING alarms only
  3   CRITICAL alarms detected

Examples:
  tsx scripts/check-wal-integrity.ts --archive /mnt/wal-archive
  tsx scripts/check-wal-integrity.ts --archive /mnt/wal-archive --format json
  tsx scripts/check-wal-integrity.ts --archive /mnt/wal-archive --min-severity CRITICAL
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    return 0;
  }

  if (!args.archive) {
    console.error("Error: --archive <path> is required.\n");
    printHelp();
    return 1;
  }

  let exitCode = 0;
  try {
    const checker = new WalIntegrityChecker(args.archive);
    const report = await checker.check();

    // Dispatch alarms to stderr
    const reporter = new WalAlarmReporter({ minSeverity: args.minSeverity });
    await reporter.dispatch(report);

    // Print report to stdout
    if (args.format === "json") {
      console.log(formatReportJson(report));
    } else {
      console.log(formatReportText(report));
    }

    exitCode = exitCodeForReport(report);
  } catch (err) {
    console.error(
      "Fatal error:",
      err instanceof Error ? err.message : String(err),
    );
    exitCode = 1;
  }

  return exitCode;
}

// Run when invoked directly
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  main().then((code) => process.exit(code));
}
