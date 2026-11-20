#!/bin/bash
set -euo pipefail
umask 022

[[ $# == 3 ]] || { printf '%s\n' 'Usage: pack.sh EXECUTABLE PLATFORM OUTPUT_DIR' >&2; exit 1; }
case "$2" in macos-arm64|linux-arm64|linux-x64) ;; *) exit 1 ;; esac
binary=$1
platform=$2
out=$3
[[ -f $binary && -x $binary && ! -L $binary ]] || exit 1
reported=$("$binary" --version)
[[ $reported =~ ^axi\ ([0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?)\ \(([0-9a-f]{40})\)$ ]] || exit 1
version="v${BASH_REMATCH[1]}"
commit=${BASH_REMATCH[3]}
digest() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d ' ' -f 1
  else shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}
mkdir -p "$out"
asset=axi-$platform.gz
meta=axi-$platform.build
[[ ! -e "$out/$asset" && ! -e "$out/$meta" ]] || exit 1
gzip -n -c "$binary" > "$out/$asset"
printf '%s\n' "axi-$platform" "$version" "$commit" "$(digest "$binary")" > "$out/$meta"
printf '%s  %s\n' "$(digest "$out/$asset")" "$asset" "$(digest "$out/$meta")" "$meta" > "$out/$platform.SHA256SUMS"
