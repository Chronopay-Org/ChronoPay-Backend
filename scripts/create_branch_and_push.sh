#!/usr/bin/env bash
set -euo pipefail

# Helper: create branch, commit changes, and push upstream.
# Usage: ./scripts/create_branch_and_push.sh devops/dependency-scanning "commit message"

BRANCH=${1:-devops/dependency-scanning}
MSG=${2:-"devops: dependency and code vulnerability scanning"}

git checkout -b "$BRANCH"
git add .
git commit -m "$MSG"
git push -u origin "$BRANCH"

echo "Branch '$BRANCH' pushed. Open a PR against 'main'."
