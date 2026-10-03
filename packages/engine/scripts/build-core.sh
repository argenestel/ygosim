#!/usr/bin/env bash
# Rebuild the vendored synchronous core. Requires git, Docker, Node and pnpm install.
# EMXX=/path/to/em++ selects an already activated Emscripten SDK instead of Docker.
set -euo pipefail
ENGINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE_REV="${CORE_REV:-efc21aa433b88cd35b7c37db4072a35c58d9d435}"
WRAPPER_REV=9f36452f2a2464f057f7fd6e2273aa5ab589401e
EMSDK_VERSION=4.0.9
IMAGE="emscripten/emsdk:${EMSDK_VERSION}"
BUILD="$(mktemp -d "${TMPDIR:-/tmp}/ygosim-core.XXXXXX")"
trap 'rm -rf -- "$BUILD"' EXIT

checkout() {
  git init -q "$2"
  git -C "$2" remote add origin "$1"
  git -C "$2" fetch -q --depth 1 origin "$3"
  git -C "$2" checkout -q --detach FETCH_HEAD
}
checkout https://github.com/n1xx1/ocgcore-wasm.git "$BUILD/wrapper" "$WRAPPER_REV"
checkout https://github.com/edo9300/ygopro-core.git "$BUILD/wrapper/cpp/ygo" "$CORE_REV"
git -C "$BUILD/wrapper/cpp/ygo" submodule update --init --depth 1 lua/src
LUA_REV="$(git -C "$BUILD/wrapper/cpp/ygo/lua/src" rev-parse HEAD)"
mkdir -p "$BUILD/output"
cp "$ENGINE/scripts/summon-metadata.cpp" "$BUILD/wrapper/cpp/summon-metadata.cpp"

# Lua must be compiled as C++ so Lua errors unwind the core's C++ objects.
cat > "$BUILD/compile.sh" <<'COMPILE'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/wrapper"
sources=(cpp/ygo/*.cpp)
for file in cpp/ygo/lua/src/*.c; do
  case "${file##*/}" in lua.c|onelua.c|ltests.c) continue ;; esac
  sources+=("$file")
done
"${EMXX:-em++}" -x c++ -std=c++17 -Os -g0 --closure 1 -sASSERTIONS=0 \
  -sMODULARIZE=1 -sFILESYSTEM=0 -sALLOW_MEMORY_GROWTH=1 -sMALLOC=emmalloc \
  -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -fno-rtti -sNO_EXIT_RUNTIME=1 \
  -sENVIRONMENT=web \
  "-sEXPORTED_FUNCTIONS=['_malloc','_free']" \
  "-sEXPORTED_RUNTIME_METHODS=['stackSave','stackRestore','stackAlloc','getValue','stringToUTF8','lengthBytesUTF8','HEAP8','HEAPU8']" \
  -Icpp/ygo/lua/src "${sources[@]}" cpp/wasm.cpp cpp/summon-metadata.cpp -o ../output/ocgcore.sync.mjs
COMPILE
if [[ -n "${EMXX:-}" ]]; then
  "$EMXX" --version | head -1 | grep -F "$EMSDK_VERSION" >/dev/null
  bash "$BUILD/compile.sh"
else
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e EM_CACHE=/build/em-cache \
    -v "$BUILD:/build" -w /build "$IMAGE" bash /build/compile.sh
fi
node "$ENGINE/scripts/build-core-glue.mjs" "$BUILD/wrapper" "$BUILD/output"
# Supply the exact native and patched wrapper sources alongside the binary.
tar --exclude=.git --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  -czf "$BUILD/output/source.tar.gz" -C "$BUILD" \
  wrapper/cpp/ygo wrapper/cpp/wasm.cpp wrapper/cpp/summon-metadata.cpp wrapper/src wrapper/tsconfig.json compile.sh
cp "$BUILD/wrapper/cpp/ygo/COPYING" "$BUILD/output/COPYING"
cp "$BUILD/wrapper/cpp/ygo/LICENSE" "$BUILD/output/LICENSE.core"
cp "$BUILD/wrapper/LICENSE.md" "$BUILD/output/LICENSE.wrapper"
node --input-type=module - "$BUILD/output" "$CORE_REV" "$LUA_REV" "$WRAPPER_REV" "$IMAGE" <<'MANIFEST'
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const [out, core, lua, wrapper, image] = process.argv.slice(2);
const sha256 = Object.fromEntries(['ocgcore.sync.wasm', 'ocgcore.sync.mjs', 'index.mjs', 'source.tar.gz'].map(name =>
  [name, createHash('sha256').update(readFileSync(`${out}/${name}`)).digest('hex')]));
writeFileSync(`${out}/build.json`, JSON.stringify({ core, lua, wrapper, image,
  patches: ['synchronous Node loader', 'upstream 3c7d293 card-data offsets', 'read-only summon-type bridge'], sha256 }, null, 2) + '\n');
MANIFEST
mkdir -p "$ENGINE/vendor/ocgcore"
cp "$BUILD/output/"* "$ENGINE/vendor/ocgcore/"
chmod 644 "$ENGINE/vendor/ocgcore/ocgcore.sync.wasm"
echo "Built core $CORE_REV (Lua $LUA_REV) in $ENGINE/vendor/ocgcore"
