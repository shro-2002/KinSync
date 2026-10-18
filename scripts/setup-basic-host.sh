#!/usr/bin/env bash
# Fetches and builds the official MCP Apps reference host (ext-apps examples/basic-host)
# at a pinned commit. Upstream source is not modified.
#
# Notes (see docs/FRICTION_LOG.md F-09..F-11):
#  - Standalone install lacks two monorepo-root devDeps: @types/cors (tsc) and cross-env
#    (build script). We add @types/cors with --no-save and call vite directly with INPUT=...
#  - Must not live under a dot-directory: Express sendFile refuses dotfile paths (404).
set -euo pipefail
SHA=82221c0c8ce7661efa6771c9d461511b1650495f
DEST=${1:-hosts/ext-apps}
case "$DEST" in */.*|.*) echo "DEST must not contain a dot-directory" >&2; exit 1;; esac

if [ ! -d "$DEST/.git" ]; then
  git clone -q --filter=blob:none --no-checkout https://github.com/modelcontextprotocol/ext-apps.git "$DEST"
  git -C "$DEST" sparse-checkout set --no-cone examples/basic-host LICENSE
fi
git -C "$DEST" checkout -q "$SHA"

cd "$DEST/examples/basic-host"
npm install --no-audit --no-fund
npm install --no-audit --no-fund --no-save @types/cors@2.8.19
npx tsc --noEmit
NODE_ENV=development INPUT=index.html npx vite build
NODE_ENV=development INPUT=sandbox.html npx vite build
git -C ../.. status --short
echo "basic-host built at $(pwd)/dist (commit $SHA)"
