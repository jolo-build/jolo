#!/usr/bin/env bash
# Jolo CLI installer. Compatible with the Bash 3.2 included with macOS.
# The final invocation runs only after Bash has received the complete function.
jolo_install_main() (
  set -euo pipefail
  umask 022
  export CDPATH=

  fail() { printf 'jolo: %s\n' "$*" >&2; exit 1; }
  say() { printf '%s\n' "$*"; }
  usage() {
    cat <<'USAGE'
Install the Jolo CLI and its bundled runtime.

Usage: bash install.sh [--version VERSION] [--prefix DIRECTORY]

  --version VERSION   Install a specific release (default: latest).
  --prefix DIRECTORY  Install under DIRECTORY/bin and DIRECTORY/share/jolo.
                      Default: ~/.local. No sudo or shell-profile edits.
  --help              Show this help.

Run the installer again to upgrade. Previous releases are retained so that
existing tasks can finish. Only published platform builds can be installed.
USAGE
  }

  version=''
  prefix=${HOME:?HOME must be set}/.local
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --help|-h) usage; exit 0 ;;
      --version) [ "$#" -ge 2 ] || fail '--version needs a value'; version=${2#v}; shift 2 ;;
      --prefix) [ "$#" -ge 2 ] || fail '--prefix needs a value'; prefix=$2; shift 2 ;;
      *) fail "Unknown argument: $1 (use --help)" ;;
    esac
  done
  [ -n "$prefix" ] || fail 'The installation prefix cannot be empty.'
  case "$prefix" in *$'\n'*|*$'\r'*) fail 'The installation prefix contains a newline.' ;; esac
  version_pattern='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$'
  if [ -n "$version" ]; then [[ $version =~ $version_pattern ]] || fail 'Invalid release version.'; fi

  for dependency in curl tar mktemp uname mkdir mv ln readlink awk; do
    command -v "$dependency" >/dev/null 2>&1 || fail "Required command not found: $dependency"
  done
  if command -v sha256sum >/dev/null 2>&1; then
    hash_file() { sha256sum "$1" | awk '{print $1}'; }
  elif command -v shasum >/dev/null 2>&1; then
    hash_file() { shasum -a 256 "$1" | awk '{print $1}'; }
  else
    fail 'SHA-256 verification requires sha256sum or shasum.'
  fi

  case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) fail 'This operating system is not supported.' ;; esac
  case "$(uname -m)" in arm64|aarch64) architecture=arm64 ;; x86_64|amd64) architecture=x64 ;; *) fail 'This CPU architecture is not supported.' ;; esac
  target=$platform-$architecture
  base_url=${JOLO_INSTALL_BASE_URL:-https://jolo.build}
  base_url=${base_url%/}
  # HTTP is allowed only for an explicitly selected loopback test server.
  local_pattern='^http://(127\.0\.0\.1|localhost)(:[0-9]+)?$'
  https_pattern='^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._/-]+)?$'
  if [[ $base_url =~ $local_pattern ]]; then
    download() { curl --proto '=http' --fail --silent --show-error --retry 2 --connect-timeout 15 --max-time 300 --max-filesize "$3" --output "$2" "$1"; }
  elif [[ $base_url =~ $https_pattern ]]; then
    download() { curl --proto '=https' --proto-redir '=https' --fail --silent --show-error --location --retry 2 --connect-timeout 15 --max-time 300 --max-filesize "$3" --output "$2" "$1"; }
  else
    fail 'The download origin must use HTTPS (or localhost HTTP for tests).'
  fi
  # A GitHub release lays its assets out by tag; any other origin serves them under
  # /releases/VERSION/. Both resolve to the same published files and checksums. `jolo update`
  # states the layout it resolved, so the installer and the updater cannot disagree about it.
  github_pattern='^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'
  layout=${JOLO_INSTALL_LAYOUT:-}
  if [ -z "$layout" ]; then
    if [[ $base_url =~ $github_pattern ]]; then layout=github; else layout=origin; fi
  fi
  case "$layout" in
    github)
      latest_url=$base_url/releases/latest/download/latest.txt
      release_directory() { printf '%s/releases/download/v%s' "$base_url" "$1"; } ;;
    origin)
      latest_url=$base_url/releases/latest.txt
      release_directory() { printf '%s/releases/%s' "$base_url" "$1"; } ;;
    *) fail 'JOLO_INSTALL_LAYOUT must be github or origin.' ;;
  esac

  work_dir=$(mktemp -d "${TMPDIR:-/tmp}/jolo-download.XXXXXX")
  stage_dir=''
  link_dir=''
  lock_dir=''
  cleanup() {
    [ -z "$work_dir" ] || rm -rf -- "$work_dir"
    [ -z "$stage_dir" ] || rm -rf -- "$stage_dir"
    [ -z "$link_dir" ] || rm -rf -- "$link_dir"
    [ -z "$lock_dir" ] || rmdir -- "$lock_dir" 2>/dev/null || true
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if [ -z "$version" ]; then
    download "$latest_url" "$work_dir/latest.txt" 1024 || fail 'Could not find the latest Jolo release.'
    version=$(cat "$work_dir/latest.txt")
    [[ $version =~ $version_pattern ]] || fail 'The server returned an invalid release version.'
  fi
  archive=jolo-cli-$target.tar.gz
  release_url=$(release_directory "$version")
  say "Installing Jolo $version for $target..."
  download "$release_url/$archive.sha256" "$work_dir/checksum" 1024 || fail "No downloadable Jolo $version build is available for $target."
  checksum_pattern='^[0-9a-f]{64}$'
  expected=''; filename=''; extra=''
  read -r expected filename extra < "$work_dir/checksum" || fail 'The checksum file is incomplete.'
  [[ $expected =~ $checksum_pattern ]] && [ "$filename" = "$archive" ] && [ -z "$extra" ] || fail 'The checksum file is invalid.'
  download "$release_url/$archive" "$work_dir/$archive" 268435456 || fail 'The release download failed.'
  [ "$(hash_file "$work_dir/$archive")" = "$expected" ] || fail 'Checksum mismatch. Nothing was installed.'

  # Reject traversal, unexpected paths, links, and device entries before extraction.
  tar -tzf "$work_dir/$archive" > "$work_dir/entries" || fail 'The release archive is invalid.'
  safe_path='^[A-Za-z0-9._/-]+$'
  while IFS= read -r entry; do
    entry=${entry#./}
    entry=${entry%/}
    [ -n "$entry" ] || continue
    [[ $entry =~ $safe_path ]] || fail 'The archive contains an unsafe filename.'
    case "/$entry/" in *'/../'*|*'/./'*|*'//'*) fail 'The archive contains an unsafe path.' ;; esac
    case "$entry" in bin|bin/|bin/jolo|lib|lib/|lib/*|README.md|VERSION) ;; *) fail "Unexpected archive path: $entry" ;; esac
  done < "$work_dir/entries"
  tar -tvzf "$work_dir/$archive" > "$work_dir/types" || fail 'Could not inspect the release archive.'
  while IFS= read -r entry; do
    case "$entry" in -*) ;; d*) ;; *) fail 'The archive contains a link or special file.' ;; esac
  done < "$work_dir/types"

  mkdir -p -- "$prefix"
  prefix=$(cd -P "$prefix" && pwd)
  install_root=$prefix/share/jolo
  releases_dir=$install_root/releases
  bin_dir=$prefix/bin
  mkdir -p -- "$releases_dir" "$bin_dir"
  if mkdir "$install_root/.install-lock" 2>/dev/null; then lock_dir=$install_root/.install-lock
  else fail "Another installation is active. If it was interrupted, remove $install_root/.install-lock and retry."; fi
  if [ -e "$bin_dir/jolo" ] || [ -L "$bin_dir/jolo" ]; then
    [ -L "$bin_dir/jolo" ] && [ ! -d "$bin_dir/jolo" ] || fail "Refusing to overwrite the existing $bin_dir/jolo."
    case "$(readlink "$bin_dir/jolo")" in ../share/jolo/releases/*/bin/jolo) ;; *) fail "The existing $bin_dir/jolo is not managed by this installer." ;; esac
  fi

  stage_dir=$(mktemp -d "$releases_dir/.install.XXXXXX")
  tar -xzf "$work_dir/$archive" --no-same-owner --no-same-permissions -C "$stage_dir" || fail 'Could not unpack the release.'
  for required in bin/jolo lib/bun lib/jolo.js lib/engine.js VERSION; do
    [ -f "$stage_dir/$required" ] && [ ! -L "$stage_dir/$required" ] || fail "The release is missing $required."
  done
  [ "$(cat "$stage_dir/VERSION")" = "$version" ] || fail 'The archive version does not match the requested release.'
  chmod 755 "$stage_dir/bin/jolo" "$stage_dir/lib/bun"
  [ ! -f "$stage_dir/lib/tgrep" ] || chmod 755 "$stage_dir/lib/tgrep"
  "$stage_dir/bin/jolo" --version >/dev/null || fail 'The downloaded CLI could not start. Your previous installation is unchanged.'
  printf '%s\n' "$expected" > "$stage_dir/ARCHIVE_SHA256"
  release_name=$version-$target-${stage_dir##*.}
  mv "$stage_dir" "$releases_dir/$release_name"
  stage_dir=''
  link_dir=$(mktemp -d "$bin_dir/.jolo-link.XXXXXX")
  ln -s "../share/jolo/releases/$release_name/bin/jolo" "$link_dir/jolo"
  # The destination is a file symlink, so rename replaces it atomically on macOS and Linux.
  mv -f "$link_dir/jolo" "$bin_dir/jolo"
  say "Installed Jolo $version to $bin_dir/jolo"
  case ":${PATH:-}:" in
    *":$bin_dir:"*) say 'Run jolo from a project directory to get started.' ;;
    *) say 'Add this directory to your shell PATH:'; printf '  %s\n' "$bin_dir"; say "For now, run: \"$bin_dir/jolo\"" ;;
  esac
)

jolo_install_main "$@"
