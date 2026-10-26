#!/usr/bin/env bash
# Installs a packed tarball into a new project with Medusa, as a store would,
# and checks the package's exports from there:
#   scripts/install-test.sh <tgz> <medusa version>
# The project is a temporary directory, removed afterwards.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <tgz> <medusa version>" >&2
  exit 2
fi
tgz="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
medusa="$2"
scripts="$(cd "$(dirname "$0")" && pwd)"

tmp="${TMPDIR:-/tmp}"
dir="$(mktemp -d "${tmp%/}/pt-install-$medusa.XXXXXX")"
trap 'rm -rf "$dir"' EXIT

echo "Installing $(basename "$tgz") with Medusa $medusa in $dir"
cd "$dir"
npm init -y > /dev/null
# No --legacy-peer-deps: a peer range a store can't satisfy fails here.
npm install "$tgz" "@medusajs/framework@$medusa" "@medusajs/medusa@$medusa" --no-audit --no-fund

node "$scripts/check-exports.cjs" "$dir"
