#!/usr/bin/env bash
# Runs the extension's @vscode/test-electron suite headlessly.
# Falls back to a normal run if xvfb-run isn't installed (e.g. local dev
# on a machine that already has a display, or Windows/macOS agents).
set -euo pipefail

if command -v xvfb-run >/dev/null 2>&1; then
  echo "Running extension tests under Xvfb..."
  xvfb-run --auto-servernum --server-args='-screen 0 1280x1024x24' npm test
else
  echo "xvfb-run not found — running tests directly (expects a real display)."
  npm test
fi
