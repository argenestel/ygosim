#!/usr/bin/env bash
# Fetch card scripts, card databases and system strings into ./data (gitignored).
# Usage: scripts/fetch-data.sh (re-run to refresh data; card scripts are pinned).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${YGOSIM_DATA:-${ROOT}/data}"
# Tested with packages/engine/vendor/ocgcore/build.json. Upgrade this pin together
# with the core, then run engine tests, fuzz-duels.ts and audit-scripts.ts.
CARD_SCRIPTS_REV="${CARD_SCRIPTS_REV:-242ce154c2c8dad08e24fa2330b96b6d25420b07}"
DATA="$(realpath -m -- "$DATA")"
if [[ "$DATA" == "/" || -z "$DATA" ]]; then
  echo "refusing to use an unsafe data path: $DATA" >&2
  exit 2
fi
mkdir -p -- "$DATA"

sync_repo() { # url dir [revision]
  local url="$1"
  local target="$2"
  if [[ -d "$target/.git" ]]; then
    if [[ -z "${3:-}" ]]; then
      git -C "$target" pull --ff-only --depth 1
    fi
  elif [[ -e "$target" ]]; then
    echo "refusing to replace non-git data directory: $target" >&2
    return 1
  else
    git clone --depth 1 "$url" "$target"
  fi
  if [[ -n "${3:-}" ]]; then
    git -C "$target" fetch --depth 1 origin "$3"
    git -C "$target" checkout --detach FETCH_HEAD
  fi
}

sync_repo https://github.com/ProjectIgnis/CardScripts.git "$DATA/CardScripts" "$CARD_SCRIPTS_REV"
sync_repo https://github.com/ProjectIgnis/BabelCDB.git "$DATA/BabelCDB"
sync_repo https://github.com/ProjectIgnis/LFLists.git "$DATA/LFLists"
if ! curl -fsSL -o "$DATA/strings.conf" \
  https://raw.githubusercontent.com/ProjectIgnis/Distribution/master/config/strings.conf; then
  echo "warning: could not fetch strings.conf (system strings will be generic)" >&2
fi
echo "Data ready in $DATA"
