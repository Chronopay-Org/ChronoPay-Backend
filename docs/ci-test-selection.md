# CI Test Selection by File-Change Graph

## Overview

Pull requests run only the tests affected by their changed files, using a
**static dependency graph** (`scripts/test-graph.json`). This keeps CI fast
without sacrificing correctness.

Pushes to `main` always run the **full test suite**, unconditionally.

---

## How it works

```
PR opened / updated
        │
        ▼
git diff --name-only origin/<base>...HEAD
        │
        ▼
npx tsx scripts/select-tests.ts
        │
        ├── Every changed file IS in the graph
        │   and maps to a non-empty list?
        │           │
        │           ▼
        │     Run only the listed test files
        │       (passed as Jest --testPathPattern)
        │
        └── Any changed file NOT in the graph,
            OR maps to [] (full-run sentinel),
            OR any error?
                    │
                    ▼
              Run the full test suite
```

### Components

| File | Purpose |
|---|---|
| `scripts/test-graph.json` | Static map: source file → test files |
| `scripts/select-tests.ts` | CLI tool that reads the graph and emits a test list or `__full_run__` |
| `.github/workflows/ci.yml` | Calls the tool on PRs; full run unconditionally on `main` |
| `src/__tests__/select-tests.test.ts` | Unit tests (38 tests, ≥95% coverage) |

---

## The static graph (`scripts/test-graph.json`)

### Format

```jsonc
{
  // Human-readable notes — never a file path key
  "__comment__": ["..."],

  // CI/config sentinel — any key mapping to [] triggers a full run
  "__ci_files__": [],

  // Normal entries
  "src/services/checkout.ts": [
    "src/__tests__/checkout-pay.test.ts",
    "src/routes/__tests__/checkout.test.ts"
  ],

  // Config/infrastructure — empty list forces a full run on any change
  "jest.config.cjs": [],
  ".github/workflows/ci.yml": []
}
```

Keys are POSIX-style paths relative to the repo root. Values are arrays of
test file paths (also POSIX-style, relative to root).

### Special values

| Value | Meaning |
|---|---|
| Non-empty array | Run exactly these test files when the source file changes |
| `[]` empty array | **Full-run sentinel** — any change to this file triggers the full suite |

Use `[]` for: `jest.config.cjs`, `tsconfig.json`, `package.json`,
`package-lock.json`, all `.github/workflows/*.yml`, `Dockerfile`, etc.

---

## Safety contract

All six properties are tested in `src/__tests__/select-tests.test.ts`:

1. **Unknown file → full run.** Any changed file not present in the graph
   triggers `__full_run__`. A brand-new source file can never silently skip
   its tests.

2. **Empty-list sentinel → full run.** CI/config files map to `[]`, so any
   infrastructure change revalidates the whole suite.

3. **Deleted test → silently skipped.** `filterExisting` drops test paths
   that no longer exist on disk. If *all* resolved tests are missing, falls
   back to a full run.

4. **Corrupt or missing graph → full run.** Any I/O or JSON parse error
   causes the tool to emit `__full_run__` — never a silent empty run.

5. **Unexpected internal error → full run.** The resolve step is wrapped in
   a broad catch that falls back rather than failing CI.

6. **No changed files → full run.** An empty diff is treated conservatively.

---

## CI workflow integration

The relevant section of `.github/workflows/ci.yml`:

```yaml
# Fetch full history on PRs so git diff can find the merge-base.
- uses: actions/checkout@v4
  with:
    fetch-depth: ${{ github.event_name == 'pull_request' && 0 || 1 }}

# Step 1 — collect changed files (PR only)
- name: Get changed files
  id: changed_files
  if: github.event_name == 'pull_request'
  run: |
    git diff --name-only origin/${{ github.base_ref }}...HEAD \
      > /tmp/changed_files.txt

# Step 2 — select tests
- name: Select tests
  id: select_tests
  if: github.event_name == 'pull_request'
  run: |
    mapfile -t changed < /tmp/changed_files.txt
    npx tsx scripts/select-tests.ts \
      --changed-files "${changed[@]}" \
      --graph scripts/test-graph.json \
      --output /tmp/selected-tests.txt \
      --verbose

# Step 3a — full run on main
- name: Run tests (full — main)
  if: github.event_name != 'pull_request'
  run: npm test

# Step 3b — selected or full run on PR
- name: Run tests (selected — PR)
  if: github.event_name == 'pull_request'
  run: |
    SELECTION=$(cat /tmp/selected-tests.txt)
    if [ "$SELECTION" = "__full_run__" ]; then
      npm test
    else
      mapfile -t TEST_PATHS < /tmp/selected-tests.txt
      npm test -- --testPathPattern="$(IFS='|'; echo "${TEST_PATHS[*]}")"
    fi
```

`fetch-depth: 0` on PRs ensures `git diff origin/<base>...HEAD` always has
enough history to compute the merge-base correctly. On `main` pushes,
`depth: 1` is sufficient because the diff step is skipped entirely.

---

## Running the selector locally

```bash
# Print selected tests to stdout
npx tsx scripts/select-tests.ts \
  --changed-files src/services/checkout.ts src/routes/checkout.ts \
  --verbose

# Write to a file and run with Jest
npx tsx scripts/select-tests.ts \
  --changed-files src/services/checkout.ts \
  --output /tmp/selected.txt

SELECTION=$(cat /tmp/selected.txt)
if [ "$SELECTION" = "__full_run__" ]; then
  npm test
else
  mapfile -t TESTS < /tmp/selected.txt
  npm test -- --testPathPattern="$(IFS='|'; echo "${TESTS[*]}")"
fi
```

---

## Maintaining the graph

The graph is manually maintained. Keep it accurate — stale entries cause
missed test runs.

### When to update `scripts/test-graph.json`

| Change | Required update |
|---|---|
| Add a new source file | Add a key mapping it to its test file(s) |
| Add a new test file | Update all source keys that should trigger it |
| Rename a source or test file | Update all affected keys and values |
| Delete a source file | Remove its key |
| Delete a test file | Remove it from all value arrays |
| Add a new CI/config file | Add a key with `[]` |

### Review checklist for graph PRs

- [ ] Every new source file has a graph entry
- [ ] Every new test file appears in at least one value array
- [ ] No value array contains a deleted/renamed test path
- [ ] New CI/infrastructure files map to `[]`
- [ ] `npm test -- --testPathPattern="select-tests"` passes

### Smoke tests built into CI

`src/__tests__/select-tests.test.ts` includes tests that run against the
committed graph file itself, verifying:

- It is valid JSON and a plain object
- `__ci_files__` maps to `[]`
- `scripts/select-tests.ts` maps to `src/__tests__/select-tests.test.ts`
- `scripts/test-graph.json` maps to `src/__tests__/select-tests.test.ts`
- All CI/config files listed map to `[]`

---

## Design decisions

**Static graph, not dynamic import analysis.** Parsing `import` statements at
CI time is fragile (runtime-only deps, barrel re-exports, plugin loading) and
adds tooling complexity. A static JSON file is explicit, reviewable, and
requires no execution.

**Fail-open (full run on any uncertainty).** The worst outcome of a bug in the
selector is a slower CI run, not a missed regression. Unknown file → full run.
Corrupt graph → full run. Empty changeset → full run.

**POSIX paths everywhere.** Git always outputs forward-slash paths even on
Windows. The tool normalises all incoming paths before lookup so the graph
works identically on all platforms.

**`[]` sentinel over a special key.** Having infrastructure files map to the
empty list keeps the format uniform — one file, one entry, one intent — rather
than requiring a separate allowlist of "CI files".

---

## Coverage

`scripts/select-tests.ts` maintains **≥95% statement and line coverage**
(currently 97%). The only excluded code is the CLI entry point
(`parseArgs`, `main`, and the `isMain` guard), marked
`/* istanbul ignore next */` because they require direct process execution.

Run coverage locally:

```bash
npm test -- \
  --testPathPattern="select-tests" \
  --coverage \
  --collectCoverageFrom="scripts/select-tests.ts" \
  --coverageThreshold="{}" \
  --coverageReporters="text"
```
