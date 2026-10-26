#!/usr/bin/env bash
# Installs a packed tarball into a new project with Medusa, as a store would,
# and checks the package from there:
#   scripts/install-test.sh <tgz> <medusa version>
# - that the project has that version of Medusa;
# - its exports (scripts/check-exports.cjs);
# - its declarations, by type-checking scripts/consumer-fixture with
#   moduleResolution node16 and bundler.
# The project is a temporary directory, removed afterwards.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <tgz> <medusa version>" >&2
  exit 2
fi
tgz="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
medusa="$2"
scripts="$(cd "$(dirname "$0")" && pwd)"
name=medusa-plugin-print-trail

tmp="${TMPDIR:-/tmp}"
dir="$(mktemp -d "${tmp%/}/pt-install-$medusa.XXXXXX")"
trap 'rm -rf "$dir"' EXIT

echo "Installing $(basename "$tgz") with Medusa $medusa in $dir"
cd "$dir"
npm init -y > /dev/null
# No --legacy-peer-deps: a peer range a store can't satisfy fails here.
npm install "$tgz" "@medusajs/framework@$medusa" "@medusajs/medusa@$medusa" typescript@5.9.3 @types/node@20 --no-audit --no-fund

# The project has the Medusa it was asked for. (Read by path: the framework
# doesn't export its package.json.)
for package in @medusajs/framework @medusajs/medusa; do
  installed="$(node -p "require('./node_modules/$package/package.json').version")"
  if [ "$installed" != "$medusa" ]; then
    echo "FAIL: $package is $installed, not $medusa" >&2
    exit 1
  fi
  echo "ok: $package $installed"
done

node "$scripts/check-exports.cjs" "$dir"

cp "$scripts/consumer-fixture/consumer.ts" "$scripts/consumer-fixture/deep-import.ts" "$dir/"
tsc=("$dir/node_modules/.bin/tsc" --noEmit --strict --pretty false --target es2022 --esModuleInterop --types node)
for resolution in node16 bundler; do
  if [ "$resolution" = node16 ]; then
    mode=(--module node16 --moduleResolution node16)
  else
    mode=(--module esnext --moduleResolution bundler)
  fi

  # The consumer compiles, so each @ts-expect-error in it found its error.
  "${tsc[@]}" "${mode[@]}" --skipLibCheck consumer.ts
  echo "ok: tsc ($resolution): consumer.ts"

  out="$("${tsc[@]}" "${mode[@]}" --skipLibCheck deep-import.ts 2>&1 || true)"
  if ! grep -q "^deep-import\.ts(.*error TS2307" <<< "$out"; then
    echo "$out"
    echo "FAIL: tsc ($resolution): expected TS2307 for the deep import" >&2
    exit 1
  fi
  echo "ok: tsc ($resolution): a deep import is TS2307"

  # With skipLibCheck off, no error may be in the package's declarations.
  # Medusa's own have some, which are reported as a count.
  out="$("${tsc[@]}" "${mode[@]}" consumer.ts 2>&1 || true)"
  ours="$(grep -E "^(node_modules/$name/|consumer\.ts\()" <<< "$out" || true)"
  if [ -n "$ours" ]; then
    echo "$ours"
    echo "FAIL: tsc ($resolution): errors in the package's declarations or the consumer" >&2
    exit 1
  fi
  echo "ok: tsc ($resolution): no error in the package's declarations ($(grep -c "error TS" <<< "$out" || true) in Medusa's own)"
done
