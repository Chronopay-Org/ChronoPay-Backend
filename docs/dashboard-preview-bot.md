# Dashboard Preview Bot

The dashboard preview bot posts a PR comment whenever files under `ops/dashboards/*.json` change. It helps reviewers see structural dashboard changes without opening Grafana.

## What it does

1. Detects changed dashboard JSON files via `git diff`.
2. Parses base/head versions and diffs panels by `id` (added, removed, modified).
3. Renders simple PNG panel-preview cards (title, type, status bar) using an inline PNG encoder (no extra npm deps).
4. Writes PNGs to `dashboard-preview-out/` and uploads them as a workflow artifact.
5. Posts/updates a PR comment with panel summaries, truncated JSON diff (200 lines max), and inline PNG when small enough.

## Fork safety

Fork PRs are skipped at two levels:

- **Workflow:** `if: github.event.pull_request.head.repo.full_name == github.repository`
- **Script:** `isForkPr()` treats missing `HEAD_REPO` as unsafe when `GITHUB_EVENT_NAME=pull_request`

Fork PRs receive a suppression message instead of dashboard content.

## Edge cases

| Case | Behavior |
|------|----------|
| Deleted dashboard file | Loads base from `git show`, status `removed`, lists removed panels |
| Deleted panel | Listed under **Removed panels** |
| Invalid JSON | Status `invalid`, explicit error note in comment |
| Large JSON diff | Truncated to 200 lines with overflow note |
| Large dashboard | PNG shows first 20 panels with "+N more" note |
| Large PNG (>50 KB) | Artifact link instead of inline data-URI |

## Local usage

```bash
BASE_REF=origin/main \
HEAD_SHA=$(git rev-parse HEAD) \
GITHUB_REPOSITORY=Chronopay-Org/ChronoPay-Backend \
GITHUB_EVENT_NAME=pull_request \
HEAD_REPO=Chronopay-Org/ChronoPay-Backend \
npx tsx scripts/dashboard-preview-bot.ts
```

PNGs are written to `dashboard-preview-out/`.

## Tests

```bash
npm test -- --testPathPattern='dashboard-preview-bot' --coverage=false
```
