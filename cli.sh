#!/bin/sh
# Cheaper installer.  Usage:  curl -fsSL https://cheaper.app/cli.sh | sh
# Optional args are passed to `cheaper install` (default: --all).
set -e
printf '\n  Cheaper — adaptive Claude model routing\n\n'
if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js 16+ is required. Install it from https://nodejs.org and re-run." >&2
  exit 1
fi
if [ "$#" -eq 0 ]; then set -- --all; fi
echo "  Installing via npx cheaper ..."
exec npx --yes cheaper@latest install "$@"
