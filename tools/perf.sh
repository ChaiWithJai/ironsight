#!/usr/bin/env bash
# Headless web-performance profile of IRONSIGHT.
#
# The third sibling of tools/shoot.sh and tools/soak.sh: same node pinning, same
# reasoning. Playwright needs node >= 20, which the machine default may not be.
# Everything after the script name is forwarded straight to tools/perf.mjs.
#
#   ./tools/perf.sh
#   ./tools/perf.sh --routes learn,forge --no-build
#   ./tools/perf.sh --frames 240 --out tools/perf/rev.json
#
# Exit code is 0 on success; non-zero on build/ready/console failure, or a budget
# breach under --strict.
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
exec node tools/perf.mjs "$@"
