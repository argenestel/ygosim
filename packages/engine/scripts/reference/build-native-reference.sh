#!/usr/bin/env bash
# Build a pinned, unmodified EDOPro/YGOPro native core for differential tests.
# Requires git, g++, ninja and Python 3. No generated binaries enter the repo.
set -euo pipefail
ROOT="${1:-/tmp/ygosim-reference}"
REV=efc21aa433b88cd35b7c37db4072a35c58d9d435
LUA_REV=6e22fedb74cf0c9b6656e9fce8b7331db847c605
mkdir -p "$ROOT"
ROOT="$(cd "$ROOT" && pwd)"
if [[ ! -d "$ROOT/ygopro-core" ]]; then
  git clone --recurse-submodules https://github.com/edo9300/ygopro-core.git "$ROOT/ygopro-core"
  git -C "$ROOT/ygopro-core" checkout --detach "$REV"
  git -C "$ROOT/ygopro-core" submodule update --init --recursive
fi
# Never reset an existing checkout or silently use a different reference.
[[ "$(git -C "$ROOT/ygopro-core" rev-parse HEAD)" == "$REV" ]] || { echo 'Unexpected reference revision' >&2; exit 1; }
[[ "$(git -C "$ROOT/ygopro-core/lua/src" rev-parse HEAD)" == "$LUA_REV" ]] || { echo 'Unexpected Lua revision' >&2; exit 1; }
[[ -z "$(git -C "$ROOT/ygopro-core" status --porcelain)" ]] || { echo 'Reference source has local changes' >&2; exit 1; }
mkdir -p "$ROOT/build"
python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1]); src = root / 'ygopro-core'; out = root / 'build'
# Ninja paths and shell compiler paths use distinct escaping.
def path(p): return str(p).replace('$', '$$').replace(' ', '$ ').replace(':', '$:')
def shell(p): return "'" + str(p).replace("'", "'\\''") + "'"
lines = [
 'rule cc',
 ' command = g++ -x c++ -std=c++17 -O2 -DNDEBUG -fPIC -DLUA_USE_LINUX -include ' + shell(src / 'lua/luaconf-customize.h') + ' -I' + shell(src / 'lua/src') + ' -c $in -o $out',
 'rule cxx',
 ' command = g++ -std=c++17 -O2 -DNDEBUG -fPIC -I' + shell(src / 'lua/src') + ' -I' + shell(src) + ' -c $in -o $out',
 'rule link', ' command = g++ -shared $in -ldl -lm -o $out',
]
objects = []
for f in list(src.glob('*.cpp')) + list((src / 'lua/src').glob('*.c')):
    if f.name in ['lua.c', 'luac.c', 'onelua.c', 'ltests.c']: continue
    obj = out / (f.stem + ('.c.o' if f.suffix == '.c' else '.cpp.o'))
    objects.append(path(obj))
    lines.append('build ' + path(obj) + ': ' + ('cc' if f.suffix == '.c' else 'cxx') + ' ' + path(f))
lines.append('build ' + path(out / 'libocgcore.so') + ': link ' + ' '.join(objects))
(out / 'build.ninja').write_text('\n'.join(lines) + '\n')
PY
ninja -C "$ROOT/build" -j "${JOBS:-4}"
echo "Native reference: $ROOT/build/libocgcore.so"
