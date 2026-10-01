#!/usr/bin/env bash
# Fetch card scripts, card databases and system strings into ./data (gitignored).
# Usage: scripts/fetch-data.sh   (re-run to update)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${YGOSIM_DATA:-${ROOT}/data}"
DATA="$(realpath -m -- "$DATA")"
if [[ "$DATA" == "/" || -z "$DATA" ]]; then
  echo "refusing to use an unsafe data path: $DATA" >&2
  exit 2
fi
mkdir -p -- "$DATA"

sync_repo() { # url dir
  local url="$1"
  local target="$2"
  if [[ -d "$target/.git" ]]; then
    git -C "$target" pull --ff-only --depth 1
  elif [[ -e "$target" ]]; then
    echo "refusing to replace non-git data directory: $target" >&2
    return 1
  else
    git clone --depth 1 "$url" "$target"
  fi
}

sync_repo https://github.com/ProjectIgnis/CardScripts.git "$DATA/CardScripts"
sync_repo https://github.com/ProjectIgnis/BabelCDB.git "$DATA/BabelCDB"
sync_repo https://github.com/ProjectIgnis/LFLists.git "$DATA/LFLists"
if ! curl -fsSL -o "$DATA/strings.conf" \
  https://raw.githubusercontent.com/ProjectIgnis/Distribution/master/config/strings.conf; then
  echo "warning: could not fetch strings.conf (system strings will be generic)" >&2
fi
echo "Data ready in $DATA"
