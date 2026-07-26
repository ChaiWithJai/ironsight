#!/usr/bin/env bash
# Frame integrity check. See tools/check-frame.mjs for what it measures and why.
# Playwright needs node >= 20, which the machine default may not be — same job
# tools/shoot.sh and tools/compare.sh do for their own entry points.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for c in /opt/homebrew/opt/node@22/bin /opt/homebrew/opt/node@21/bin /opt/homebrew/opt/node@20/bin; do
  if [ -x "$c/node" ]; then export PATH="$c:$PATH"; break; fi
done
cd "$ROOT"
exec node tools/check-frame.mjs "$@"
