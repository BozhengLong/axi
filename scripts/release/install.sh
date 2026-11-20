#!/bin/bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "Axi installer: $*" >&2; exit 1; }
version_ok() { [[ $1 =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9][a-zA-Z0-9.-]*)?$ ]]; }
digest() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d ' ' -f 1
  else shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

case "$(/usr/bin/uname -s):$(/usr/bin/uname -m)" in
  Darwin:arm64) os=macos; arch=arm64 ;;
  Linux:x86_64) os=linux; arch=x64 ;;
  Linux:aarch64|Linux:arm64) os=linux; arch=arm64 ;;
  *) fail "Unsupported OS or architecture." ;;
esac
case "${1:-}" in
  install|rollback) [[ $# -ge 2 ]] && version_ok "$2" || fail "Expected an explicit version, for example v0.0.2." ;;
  uninstall) [[ $# == 1 ]] || fail "Usage: install.sh uninstall" ;;
  *) fail "Usage: install.sh install VERSION | rollback VERSION | uninstall" ;;
esac
action=$1
version=${2:-}
mirror=
if [[ $action == install && $# == 4 && $3 == --from-directory && -d $4 ]]; then
  mirror=$4
elif [[ $action == install || $action == rollback ]]; then
  [[ $# == 2 ]] || fail "Unexpected arguments."
fi

home=${HOME:?}
state=$home/.local/share/axi
versions=$state/versions
bin=$home/.local/bin
link=$bin/axi
lock=$state/install.lock
mkdir -p "$versions" "$bin"
[[ ! -L "$state" && ! -L "$versions" ]] || fail "The managed directory may not be a symbolic link."
mkdir "$lock" || fail "An installation is in progress. Check for an active installer before clearing $lock."
temp=
new_link=
cleanup() {
  [[ -z "$temp" ]] || rm -rf -- "$temp"
  [[ -z "$new_link" ]] || rm -f -- "$new_link"
  rmdir "$lock" || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

asset="axi-$os-$arch.gz"
metadata="axi-$os-$arch.build"
registered() {
  local dir=$1 record tag commit file_hash
  [[ ! -L $dir && -f $dir/axi && ! -L $dir/axi && -x $dir/axi &&
    -f $dir/.installed && ! -L $dir/.installed ]] || return 1
  { IFS= read -r record; IFS= read -r tag; IFS= read -r commit; IFS= read -r file_hash; } < "$dir/.installed" || return 1
  [[ $record == "axi-$os-$arch" && $tag == "${dir##*/}" ]] && version_ok "$tag" &&
    [[ $commit =~ ^[0-9a-f]{40}$ && $file_hash =~ ^[0-9a-f]{64}$ && $(digest "$dir/axi") == "$file_hash" ]]
}

if [[ -e $link || -L $link ]]; then
  [[ -L $link ]] || fail "Existing executable is not managed by this installer."
  target=$(readlink "$link")
  current=${target#"$versions/"}
  current=${current%/axi}
  version_ok "$current" && [[ $target == "$versions/$current/axi" ]] &&
    registered "$versions/$current" || fail "Existing executable is not managed by this installer."
fi

if [[ $action == uninstall ]]; then
  [[ ! -L $link ]] || rm -- "$link"
  for dir in "$versions"/*; do
    if registered "$dir"; then
      rm -- "$dir/axi" "$dir/.installed"
      rmdir "$dir" 2>/dev/null || true
    fi
  done
  printf '%s\n' "Removed installer-managed Axi binaries."
  exit 0
fi

found=$(command -v axi || true)
[[ -z $found || $found == "$link" ]] || fail "A different axi is on PATH at $found."
dir="$versions/$version"
if [[ $action == install ]]; then
  temp=$(mktemp -d "$versions/.install.XXXXXXXX")
  download() {
    if [[ -n $mirror ]]; then
      cp -- "$mirror/$1" "$temp/$1"
    else
      curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
        --connect-timeout 15 --max-time 300 "https://github.com/BozhengLong/axi/releases/download/$version/$1" -o "$temp/$1"
    fi
  }
  download SHA256SUMS && download "$metadata" && download "$asset" || fail "Download failed for $version."
  for file in "$metadata" "$asset"; do
    expected=$(awk -v name="$file" '$2 == name { print $1 }' "$temp/SHA256SUMS")
    [[ $expected =~ ^[0-9a-f]{64}$ && $(digest "$temp/$file") == "$expected" ]] || fail "Checksum mismatch for $file."
  done
  { IFS= read -r platform; IFS= read -r tag; IFS= read -r commit; IFS= read -r file_hash; } < "$temp/$metadata" || fail "Incomplete build receipt."
  [[ $platform == "axi-$os-$arch" && $tag == "$version" &&
    $commit =~ ^[0-9a-f]{40}$ && $file_hash =~ ^[0-9a-f]{64}$ ]] || fail "Wrong platform, version or source revision."
  mkdir "$temp/payload"
  gzip -dc "$temp/$asset" > "$temp/payload/axi" || fail "Invalid compressed executable."
  [[ $(digest "$temp/payload/axi") == "$file_hash" ]] || fail "Executable checksum mismatch."
  chmod 755 "$temp/payload/axi"
  reported=$("$temp/payload/axi" --version) || fail "The executable failed to start on this platform."
  [[ $reported == "axi ${version#v} ($commit)" ]] || fail "The executable reported a different version or source revision."
  cp -- "$temp/$metadata" "$temp/payload/.installed"
  if [[ -e $dir || -L $dir ]]; then
    registered "$dir" && cmp -s "$dir/.installed" "$temp/$metadata" || fail "Version directory contains different files or is not managed."
  else
    mv -- "$temp/payload" "$dir"
  fi
else
  registered "$dir" || fail "No verified installation of $version is available."
fi

# 单次重命名切换入口。中断时，旧入口或新的完整入口仍然可用。
new_link=$(mktemp "$bin/.axi.XXXXXXXX")
rm -- "$new_link"
ln -s -- "$dir/axi" "$new_link"
if [[ $os == macos ]]; then mv -fh -- "$new_link" "$link"
else mv -fT -- "$new_link" "$link"
fi
new_link=
printf '%s\n' "Axi $version is active. Run 'axi setup' from your terminal."
case ":$PATH:" in
  *":$bin:"*) ;;
  *) printf '%s\n' 'Add Axi to your PATH with export PATH="$HOME/.local/bin:$PATH".' ;;
esac
