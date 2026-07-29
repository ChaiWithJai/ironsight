#!/usr/bin/env bash
# Headless behavioural soak of the IRONSIGHT simulation.
#
# The twin of tools/shoot.sh: same node pinning, same reasoning. Playwright
# needs node >= 20, which the machine default may not be. Everything after the
# script name is forwarded straight to tools/soak.mjs.
#
#   ./tools/soak.sh --seconds 60
#   ./tools/soak.sh --walk sweep --no-build
#   ./tools/soak.sh --compare tools/soak/before.json
#
# LEAK SOAK (memory / GC / frame-time over 10–30 min):
#
#   ./tools/soak.sh --profile                       # 15 min default
#   ./tools/soak.sh --profile --minutes 30
#   ./tools/soak.sh --profile --minutes 2 --no-build   # a quick shakedown
#   ./tools/soak.sh --profile --compare tools/soak/profile-before.json
#
# Exit code is the verdict: 0 when no fail-level verdict fired, 1 otherwise.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pick_node() {
  for c in /opt/homebrew/opt/node@24/bin /opt/homebrew/opt/node@22/bin \
           /opt/homebrew/opt/node@21/bin /opt/homebrew/opt/node@20/bin; do
    if [ -x "$c/node" ]; then echo "$c"; return; fi
  done
  if command -v node >/dev/null && [ "$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')" -ge 20 ]; then
    dirname "$(command -v node)"; return
  fi
  echo "no node >= 20 found (need it for playwright)" >&2
  exit 1
}

export PATH="$(pick_node):$PATH"
cd "$ROOT"
exec node tools/soak.mjs "$@"
