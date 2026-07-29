#!/usr/bin/env bash
# Capture deterministic screenshots of every /learn/ academy chapter.
# Thin wrapper so the capture runs under node >= 20.19 like everything else.
set -euo pipefail
cd "$(dirname "$0")/.."
exec bash tools/with-node.sh node tools/learn-shots.mjs "$@"
