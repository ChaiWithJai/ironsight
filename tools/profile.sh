#!/usr/bin/env bash
# Revision-stamped performance profiler for IRONSIGHT.
#
# The sibling of tools/soak.sh and tools/shoot.sh: same node pinning, same
# reasoning. Playwright (the browser section) needs node >= 20, which the
# machine default may not be, and Vite 7 (the build section) needs >= 20.19.
# Everything after the script name is forwarded straight to tools/profile.mjs.
#
#   ./tools/profile.sh                       # full profile
#   ./tools/profile.sh --no-install --no-build --only bundle
#   ./tools/profile.sh --json
#
# Exit code is 0 whenever a report was written.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pick_node() {
  if [ -n "${IRONSIGHT_NODE_BIN:-}" ] && [ -x "$IRONSIGHT_NODE_BIN/node" ]; then
    echo "$IRONSIGHT_NODE_BIN"; return
  fi
  for c in /opt/homebrew/opt/node@24/bin /opt/homebrew/opt/node@22/bin \
           /opt/homebrew/opt/node@21/bin /opt/homebrew/opt/node@20/bin; do
    if [ -x "$c/node" ]; then echo "$c"; return; fi
  done
  if command -v node >/dev/null && [ "$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')" -ge 20 ]; then
    dirname "$(command -v node)"; return
  fi
  echo "no node >= 20 found (need it for the build + browser sections)" >&2
  exit 1
}

export PATH="$(pick_node):$PATH"
cd "$ROOT"
exec node tools/profile.mjs "$@"
