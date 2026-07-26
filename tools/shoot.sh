#!/usr/bin/env bash
# Screenshot the game. Playwright needs node >= 20, which the machine default may
# not be, so pin a modern runtime here — the same job tools/with-node.sh does for
# the npm scripts. Nothing for a contributor to configure either way.
# Everything after `--` style flags is forwarded straight to tools/capture.mjs.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pick_node() {
  for c in /opt/homebrew/opt/node@22/bin /opt/homebrew/opt/node@21/bin /opt/homebrew/opt/node@20/bin; do
    if [ -x "$c/node" ]; then echo "$c"; return; fi
  done
  # Fall back to whatever is on PATH if it is already new enough.
  if command -v node >/dev/null && [ "$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')" -ge 20 ]; then
    dirname "$(command -v node)"; return
  fi
  echo "no node >= 20 found (need it for playwright)" >&2
  exit 1
}

export PATH="$(pick_node):$PATH"
cd "$ROOT"
exec node tools/capture.mjs "$@"
