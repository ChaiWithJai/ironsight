#!/usr/bin/env bash
# Run a command under node >= 20.19.
#
# The repo's default `node` on this machine is 18.x, but Vite 7 needs >= 20.19
# (it calls crypto.hash, added in 20.12/21). Rather than force every contributor
# to switch runtimes — and rather than have a dozen parallel agents each
# rediscover the same failure and "fix" it by editing shared config — every npm
# script that touches Vite routes through here.
#
#   bash tools/with-node.sh vite build
#
# tsc is fine on 18, so `typecheck` deliberately does NOT go through this: it
# stays fast and dependency-free.
set -euo pipefail

need_major=20
need_minor=19

version_ok() {
  local v; v="$("$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.stdout.write(a+" "+b)' 2>/dev/null)" || return 1
  local maj=${v% *} min=${v#* }
  (( maj > need_major )) || { (( maj == need_major )) && (( min >= need_minor )); }
}

pick() {
  # Prefer an explicit override, then Homebrew's versioned formulae (newest
  # first), then nvm's installs, then whatever is on PATH.
  if [ -n "${IRONSIGHT_NODE_BIN:-}" ] && version_ok "$IRONSIGHT_NODE_BIN/node"; then
    echo "$IRONSIGHT_NODE_BIN"; return
  fi
  for c in /opt/homebrew/opt/node@24/bin /opt/homebrew/opt/node@22/bin \
           /opt/homebrew/opt/node@21/bin /opt/homebrew/opt/node@20/bin \
           /opt/homebrew/bin /usr/local/bin; do
    [ -x "$c/node" ] && version_ok "$c/node" && { echo "$c"; return; }
  done
  for c in "$HOME"/.nvm/versions/node/*/bin; do
    [ -x "$c/node" ] && version_ok "$c/node" && { echo "$c"; return; }
  done
  if command -v node >/dev/null && version_ok "$(command -v node)"; then
    dirname "$(command -v node)"; return
  fi
  cat >&2 <<'EOF'
[with-node] No node >= 20.19 found. Vite 7 cannot build without one.
            Install one (`brew install node@22`) or set IRONSIGHT_NODE_BIN to a
            directory containing a suitable `node`.
EOF
  exit 1
}

export PATH="$(pick):$PATH"
exec "$@"
