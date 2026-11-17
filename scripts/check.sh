#!/usr/bin/env bash
# Token-saving verification: one PASS/FAIL line per step; on failure, only the
# first 40 lines of that step's output, then exit non-zero (fail fast).
# Usage: scripts/check.sh        -> typecheck, lint, unit tests
#        scripts/check.sh e2e    -> Playwright (line reporter)
set -u
cd "$(dirname "$0")/.."
OUT=".check"
mkdir -p "$OUT"

run_step() {
  local name="$1"; shift
  local log="$OUT/$name.log"
  if "$@" >"$log" 2>&1; then
    echo "PASS  $name"
  else
    echo "FAIL  $name  (full log: $log)"
    head -n 40 "$log"
    exit 1
  fi
}

if [ "${1:-}" = "e2e" ]; then
  run_step e2e npx playwright test --reporter=line --trace off
else
  run_step typecheck npx tsc --noEmit --pretty false
  run_step lint npx eslint --quiet .
  run_step unit npx vitest run --reporter=dot
fi
