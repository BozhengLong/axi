#!/bin/bash
set -euo pipefail
umask 077
if [[ $# != 2 ]]; then
  printf '%s\n' 'Usage: pack-npm.sh MACOS_ARM64_AXI OUTPUT_DIR' >&2
  exit 1
fi
binary=$1
out=$2
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || { printf '%s\n' 'The npm preview is built on macOS ARM64.' >&2; exit 1; }
[[ -f $binary && -x $binary && ! -L $binary ]] || exit 1
binary=$(cd "$(dirname "$binary")" && pwd -P)/$(basename "$binary")
scripts=$(cd "$(dirname "$0")" && pwd -P)
reported=$("$binary" --version)
if [[ ! $reported =~ ^axi\ ([0-9]+\.[0-9]+\.[0-9]+)\ \(([0-9a-f]{40})\)$ ]]; then
  printf '%s\n' 'Expected an executable built from a frozen commit.' >&2
  exit 1
fi
version=${BASH_REMATCH[1]}
commit=${BASH_REMATCH[2]}
mkdir -p "$out"
out=$(cd "$out" && pwd -P)
stage=$(mktemp -d "$out/.npm-stage.XXXXXXXX")
cleanup() {
  rm -f -- "$stage/axi-native" "$stage/cli.cjs" "$stage/package.json" "$stage/BUILD" "$stage/npm-user.conf" "$stage/npm-global.conf"
  rmdir "$stage"
}
trap cleanup EXIT
cp "$binary" "$stage/axi-native"
install -m 755 "$scripts/npm-launch.cjs" "$stage/cli.cjs"
cat > "$stage/package.json" <<JSON
{
  "name": "@axi-preview/cli",
  "version": "$version",
  "description": "Axi local coding agent developer preview",
  "private": true,
  "bin": {"axi": "./cli.cjs"},
  "files": ["axi-native", "cli.cjs", "BUILD"],
  "os": ["darwin"],
  "cpu": ["arm64"],
  "engines": {"node": ">=18"}
}
JSON
printf 'source=%s\nsha256=%s\n' "$commit" "$(shasum -a 256 "$binary" | cut -d ' ' -f 1)" > "$stage/BUILD"
touch "$stage/npm-user.conf" "$stage/npm-global.conf"
cd "$stage"
npm pack --offline --ignore-scripts --userconfig "$stage/npm-user.conf" --globalconfig "$stage/npm-global.conf" --pack-destination "$out"
