#!/usr/bin/env bash
# Token-saving verification: one PASS/FAIL line per step; on failure, only the
# first 40 and last 60 lines of that step's output, then exit non-zero (fail fast).
# Next.js server output ([WebServer] lines, prerender "Date.now()" warnings and their stack frames) is dropped from the printed excerpt, so a failing
# assertion is never pushed out of the 40/60-line window by them; the full log file keeps everything.
# Usage: scripts/check.sh        -> typecheck, lint, unit tests
#        scripts/check.sh e2e    -> Playwright (line reporter)
set -u
cd "$(dirname "$0")/.."
OUT=".check"
mkdir -p "$OUT"

# Print a log without the Next.js prerender Date.now() noise (the warning line, its "at ..." frames and blank lines after it).
quiet() {
  awk '
    /^\[WebServer\]/ || /^[0-9T:.Z-]+ \[WebServer\]/ { hidden++; next }
    /^[[:space:]]+at .*\.next\/server/ { hidden++; next }
    /Date\.now\(\)|next-prerender-current-time|blocking-prerender-current-time/ { skip = 1; hidden++; next }
    skip && /^[[:space:]]+at / { hidden++; next }
    skip && /^[[:space:]]*$/ { next }
    { skip = 0; print }
    END { if (hidden > 0) printf "(%d lines of Next.js server / prerender Date.now() warnings hidden; see the full log)\n", hidden }
  ' "$1"
}

run_step() {
  local name="$1"; shift
  local log="$OUT/$name.log"
  if "$@" >"$log" 2>&1; then
    echo "PASS  $name"
  else
    echo "FAIL  $name  (full log: $log)"
    quiet "$log" | grep -v '^[[:space:]]*$' >"$log.quiet"
    # Up to 250 lines are printed whole (Playwright's per-test errors sit in the middle); longer logs get head 40 + tail 60.
    if [ "$(wc -l <"$log.quiet")" -le 250 ]; then
      cat "$log.quiet"
    else
      head -n 40 "$log.quiet"
      echo "... (tail of the log)"
      tail -n 60 "$log.quiet"
    fi
    exit 1
  fi
}

if [ "${1:-}" = "e2e" ]; then
  PLAYWRIGHT_HTML_OPEN=never run_step e2e npx playwright test --reporter=line,html --trace off
else
  run_step typecheck npx tsc --noEmit --pretty false
  run_step lint npx eslint --quiet .
  run_step unit npx vitest run --reporter=dot
fi
