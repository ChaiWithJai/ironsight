#!/usr/bin/env bash
# Build a blind A/B comparison sheet. See tools/compare.mjs for usage.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for c in /opt/homebrew/opt/node@22/bin /opt/homebrew/opt/node@21/bin /opt/homebrew/opt/node@20/bin; do
  if [ -x "$c/node" ]; then export PATH="$c:$PATH"; break; fi
done
cd "$ROOT"
exec node tools/compare.mjs "$@"
