#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REFERENCE="${YGOSIM_REFERENCE_DIR:-${ROOT}/test-results/native-reference}"
cd "$ROOT"
bash packages/engine/scripts/reference/build-native-reference.sh "$REFERENCE"
YGOSIM_NATIVE_REFERENCE="$REFERENCE/build/libocgcore.so" \
YGOSIM_REFERENCE_REPORT="$REFERENCE/differential-report.json" \
  pnpm --filter @ygosim/engine exec vitest run test/native-reference.test.ts
