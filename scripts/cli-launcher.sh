#!/bin/sh
# Follow installed symlinks before locating the bundled runtime and CLI.
set -eu
JOLO_LAUNCHER=$0
JOLO_LINKS=0
while [ -L "$JOLO_LAUNCHER" ]; do
  JOLO_LINKS=$((JOLO_LINKS + 1))
  [ "$JOLO_LINKS" -le 40 ] || { echo 'jolo: too many launcher symlinks' >&2; exit 1; }
  JOLO_PARENT=$(CDPATH= cd -P "$(dirname "$JOLO_LAUNCHER")" && pwd)
  JOLO_LINK=$(readlink "$JOLO_LAUNCHER")
  case "$JOLO_LINK" in
    /*) JOLO_LAUNCHER=$JOLO_LINK ;;
    *) JOLO_LAUNCHER=$JOLO_PARENT/$JOLO_LINK ;;
  esac
done
JOLO_ROOT=$(CDPATH= cd -P "$(dirname "$JOLO_LAUNCHER")/.." && pwd)
exec "$JOLO_ROOT/lib/bun" "$JOLO_ROOT/lib/jolo.js" "$@"
