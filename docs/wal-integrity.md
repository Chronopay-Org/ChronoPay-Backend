# WAL Archive Integrity Checker

Validates Write-Ahead Log (WAL) archive completeness daily so point-in-time
restores are always possible.

## Overview

The checker walks the configured WAL archive directory, hash-verifies every
segment, detects gaps and duplicates in the sequence, and surfaces alarms for
any issue found. It is designed to run as a daily cron job or CI gate.

## Architecture

```
scripts/check-wal-integrity.ts  (CLI entry point)
      │
      ▼
ops/wal/walIntegrityChecker.ts  (core logic)
      │
      ├── parseSegmentFilename()   – parse PostgreSQL WAL filenames
      ├── listFiles()              – enumerate archive (injected I/O)
      ├── computeHash()            – SHA-256 per segment (streaming, timeout)
      ├── readSidecar()            – read <seg>.sha256 expected hash
      ├── gap detection            – sorted per-timeline sequence check
      ├── duplicate detection      – same LSN on multiple files (split-brain)
      └── WalIntegrityReport       – structured result
      │
      ▼
ops/wal/walAlarmReporter.ts     (formatting + alarm dispatch)
      ├── formatReportText()      – human-readable output
      ├── formatReportJson()      – structured JSON for log aggregators
      ├── exitCodeForReport()     – exit-code semantics for cron/CI
      └── WalAlarmReporter        – per-alarm dispatch with severity filter
```

## Segment Naming Convention

PostgreSQL WAL segments follow this naming pattern:

```
<timeline_hex_8><segment_hex_16>[.partial]
e.g. 000000010000000100000001
     000000010000000100000002.partial
```

- `timeline_hex_8` — 8-character hex timeline ID
- `segment_hex_16` — 16-character hex LSN position
- `.partial` — segment still being written (restore in progress)

Sidecar files `<segment>.sha256` contain the expected SHA-256 hex digest and
are used to verify integrity.

## Usage

### Direct invocation

```bash
# Text report (default)
tsx scripts/check-wal-integrity.ts --archive /mnt/wal-archive

# JSON report (pipe to log aggregator)
tsx scripts/check-wal-integrity.ts --archive /mnt/wal-archive --format json

# Only show CRITICAL alarms on stderr
tsx scripts/check-wal-integrity.ts --archive /mnt/wal-archive --min-severity CRITICAL
```

### npm script

```bash
WAL_ARCHIVE=/mnt/wal-archive npx tsx scripts/check-wal-integrity.ts --archive $WAL_ARCHIVE
```

### Cron (daily at 02:00)

```cron
0 2 * * * /usr/local/bin/tsx /app/scripts/check-wal-integrity.ts \
    --archive /mnt/wal-archive \
    --format json \
    >> /var/log/wal-integrity.log 2>&1
```

### Flags

| Flag | Short | Default | Description |
|---|---|---|---|
| `--archive` | `-a` | — | **Required.** Path to WAL archive directory |
| `--format` | `-f` | `text` | Output format: `text` or `json` |
| `--min-severity` | `-s` | `INFO` | Minimum alarm severity for stderr dispatch: `INFO`, `WARNING`, `CRITICAL` |
| `--help` | `-h` | — | Print usage |

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Archive is healthy (may have `INFO` alarms for partial segments) |
| `1` | Fatal / unexpected error |
| `2` | `WARNING` alarms only (no `CRITICAL`) |
| `3` | `CRITICAL` alarms detected — restore may be impossible |

## Alarm Codes

| Code | Severity | Meaning |
|---|---|---|
| `HASH_MISMATCH` | CRITICAL | SHA-256 of a segment does not match the sidecar |
| `GAP_DETECTED` | CRITICAL | One or more segments missing from the sequence |
| `DUPLICATE_SEGMENT` | CRITICAL | Multiple files map to the same LSN position |
| `SPLIT_BRAIN` | CRITICAL | Multiple files for the same LSN (split-brain scenario) |
| `STORAGE_TIMEOUT` | CRITICAL / WARNING | I/O timeout or error reading the archive |
| `UNREADABLE_SEGMENT` | CRITICAL | A segment file cannot be opened/read |
| `RESTORE_IN_PROGRESS` | INFO | A `.partial` segment is present (archiving in progress) |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `WAL_HASH_TIMEOUT_MS` | `30000` | Timeout in ms for hashing a single segment |

## Edge Cases Handled

### Restore in progress (`.partial` segments)

A `.partial` suffix means the segment is currently being written by the
archiver. The checker:
- Computes the hash and records it
- Raises an `INFO / RESTORE_IN_PROGRESS` alarm
- Does **not** mark the archive as unhealthy
- Does **not** raise a `HASH_MISMATCH` alarm if no sidecar exists

### Storage timeout

If listing the archive directory or hashing a segment exceeds
`WAL_HASH_TIMEOUT_MS`, a `STORAGE_TIMEOUT` alarm is raised. Processing
continues for remaining segments so the full scope of the issue is visible.

### Split-brain WAL

If two or more files parse to the same LSN position (e.g. `00000001…001` and
`00000001…001.partial`), a `SPLIT_BRAIN` alarm is raised alongside per-file
`DUPLICATE_SEGMENT` alarms. This indicates the archive is in an inconsistent
state and a restore may produce undefined results.

### Unknown files

Files that do not match the WAL segment naming convention (README, metadata,
`archive_status/`) are silently ignored.

## Testing

All logic lives in `ops/wal/walIntegrityChecker.ts` and
`ops/wal/walAlarmReporter.ts` which use a dependency-injected I/O interface
(`WalCheckerIO`). This lets tests replace filesystem calls with in-memory mocks
without touching the real filesystem.

```bash
# Run WAL integrity tests only
npm test -- --testPathPattern="ops/wal"

# Run with coverage
npm run test:coverage -- --testPathPattern="ops/wal"
```

Test files:
- `ops/wal/__tests__/walIntegrityChecker.test.ts`
- `ops/wal/__tests__/walAlarmReporter.test.ts`
- `scripts/__tests__/check-wal-integrity.test.ts`

## Integration with Alerting

For production alerting, pipe the JSON output to your log aggregator or
implement a custom `onAlarm` handler:

```typescript
import { WalIntegrityChecker } from "./ops/wal/walIntegrityChecker.js";
import { WalAlarmReporter } from "./ops/wal/walAlarmReporter.js";

const checker = new WalIntegrityChecker("/mnt/wal-archive");
const report = await checker.check();

const reporter = new WalAlarmReporter({
  minSeverity: "WARNING",
  onAlarm: async (alarm) => {
    await fetch("https://hooks.slack.com/…", {
      method: "POST",
      body: JSON.stringify({ text: `[${alarm.severity}] ${alarm.message}` }),
    });
  },
});

await reporter.dispatch(report);
process.exit(exitCodeForReport(report));
```

## Security Considerations

- Sidecar digests are read from the same archive as the segments; if the
  archive is compromised both the segment and the sidecar could be replaced.
  For tamper-evident verification, store sidecars in a separate, immutable
  location (e.g. an append-only S3 bucket with object lock).
- The checker never writes to the archive directory.
- Hashing uses Node.js built-in `crypto.createHash` — no third-party
  hash libraries with supply-chain risk.
- Streaming hashing avoids loading entire segments into memory, keeping
  memory usage bounded to one chunk at a time (~64 KiB).
