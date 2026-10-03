# Vendored synchronous core

The engine and script audit use `index.mjs`, preserving the synchronous
`createCore({ sync: true })` API and public types from `ocgcore-wasm@0.1.2`.
The npm dependency remains the source of TypeScript types and constants; its
bundled native core is no longer used by the engine.

## Versions and provenance

- Core: [edo9300/ygopro-core, efc21aa433b88cd35b7c37db4072a35c58d9d435](https://github.com/edo9300/ygopro-core/tree/efc21aa433b88cd35b7c37db4072a35c58d9d435), upstream HEAD on October 2, 2026. Reports API version 11.0 and supports CHAININFO flags 1–33.
- Lua: upstream core submodule [6e22fedb74cf0c9b6656e9fce8b7331db847c605](https://github.com/lua/lua/tree/6e22fedb74cf0c9b6656e9fce8b7331db847c605), Lua 5.4.8.
- C++ bridge and TypeScript wrapper: [n1xx1/ocgcore-wasm, 9f36452f2a2464f057f7fd6e2273aa5ab589401e](https://github.com/n1xx1/ocgcore-wasm/tree/9f36452f2a2464f057f7fd6e2273aa5ab589401e), release 0.1.2.
- Emscripten: **4.0.9**, Docker image `emscripten/emsdk:4.0.9`.
- Matching scripts: [ProjectIgnis/CardScripts, 242ce154c2c8dad08e24fa2330b96b6d25420b07](https://github.com/ProjectIgnis/CardScripts/tree/242ce154c2c8dad08e24fa2330b96b6d25420b07), September 30, 2026. `scripts/fetch-data.sh` defaults to this revision; no card sets were removed.

Release 0.1.2 originally pins core **8e5f4e4f0ab6b8ca750e8e1c91c1a58f407e3272**
(April 7, 2026) and Lua **75ea9ccbea7c4886f30da147fb67b693b2624c26** (5.3).
Its upstream build compiles Lua and the core with `em++`, adds `cpp/wasm.cpp`
callbacks/exports, generates separate synchronous and JSPI factories, and bundles
the TypeScript interface with esbuild. Its GitHub workflow uses Emscripten 4.0.9.

We rebuild the native factory and WASM together: Emscripten's generated glue
depends on the linked module's imports and exports, so replacing just the WASM
under the npm package's old factory is unsafe. We reuse the 0.1.2 bridge and
interface sources, retaining the engine's SHUFFLE_SET_CARD/SELECT_SUM decoder
and sort-response adapters. The interface's right-scale/Link-arrow memory offsets
include [upstream fix 3c7d293](https://github.com/n1xx1/ocgcore-wasm/commit/3c7d293).
The generated interface uses a Node file loader for the local WASM and accepts
the usual `wasmBinary`, `locateFile`, print hooks and runtime initialization hook.
Only the synchronous interface used by this engine is built.

The read-only `ygosimSummonType` bridge in `scripts/summon-metadata.cpp` exposes
the core card's authoritative summon type at each `SPSUMMONING` processing step.
The compatibility adapter attaches this to the decoded event before processing
the next step. Core processing returns as soon as a step produces messages, so
the lookup does not depend on a later state refresh; it checks the card's code
and location. This covers Ritual, Pendulum and contact procedures without
inferring a procedure from card type or mistaking a revival for a new procedure.
It changes neither upstream rules nor raw message/query formats. Alternate
builds without the bridge retain reason-based classification where available
and otherwise report `special` rather than guessing.

`build.json` records exact revisions and artifact SHA-256 hashes.
`source.tar.gz` contains the exact native sources, patched interface sources,
and native compiler command. Core license notices (AGPL-3.0-or-later, with
inherited MIT notices) and the wrapper's MIT license accompany the artifacts.

## Rebuild

From the repository root, after `pnpm install`, with Docker running:

```sh
bash packages/engine/scripts/build-core.sh
```

The script fetches pinned source revisions into a temporary directory, builds
with Docker, and replaces generated artifacts here only after a successful build.
It uses the existing Vitest/Vite esbuild installation and adds no dependencies.
An activated local Emscripten **4.0.9** SDK can be used when Docker is unavailable:

```sh
source /path/to/emsdk/emsdk_env.sh
EMXX=/path/to/emsdk/upstream/emscripten/em++ bash packages/engine/scripts/build-core.sh
```

The checked-in artifacts were built with that local SDK override because the
execution environment had no Docker daemon and blocked rootless containers.
The Docker invocation has not been executed in that environment.

To upgrade deliberately, supply `CORE_REV=<full-commit>` to the build and
`CARD_SCRIPTS_REV=<full-commit>` to `scripts/fetch-data.sh`, then update both
default pins and this provenance. Run the engine's full checks before accepting
a new pair; the core's API version alone does not identify script compatibility.

```sh
cd packages/engine
npx vitest run
npx tsc --noEmit
pnpm lint
npx tsx scripts/fuzz-duels.ts
npx tsx scripts/audit-scripts.ts
```

Fuzzing defaults to 200 deterministic duels with a 500-decision cap. Audit
checks compilation and `initial_effect`; gameplay fuzzing and the active-chain
regression cover runtime calls that initialization alone cannot exercise.
JSON reports go to `packages/engine/data/reports/` (gitignored). In installations
where `npx tsx` cannot find the workspace's transitive TSX binary, add
`../../node_modules/.pnpm/node_modules/.bin` to `PATH` from `packages/engine`.

## Initial deck shuffling

This core has no duel flag that shuffles decks at startup. In the archived
sources, `OCG_DuelNewCard` (`ocgapi.cpp`) appends main-deck cards supplied with
sequence 0. `Processors::Startup` (`field.cpp`) clears the shuffle checks and
draws immediately from the back of that list. `DUEL_PSEUDO_SHUFFLE`, exposed as
`OcgDuelMode.PSEUDO_SHUFFLE`, disables shuffling inside `field::shuffle`; it
does not request an initial shuffle and must remain unset.

The TypeScript wrapper therefore applies Fisher–Yates to both main decks before
insertion. A private xoshiro256** stream uses a copy of the same four 64-bit
seed words passed to the core, advancing between players in protocol player
order. Rejection sampling removes modulo bias in shuffle indices. Numeric
seeds retain the existing SplitMix64 expansion; omitted seeds use 32 bytes from
Node's `crypto.randomBytes`, generated once for both the core and wrapper.
The core's RNG state and Extra Deck order are preserved. Seeded gameplay is
reproducible, but opening hands intentionally differ from versions that inserted
the supplied main-deck list without shuffling.

## Verification on October 2, 2026

- Vitest: **120 passed**, 12 test files. TypeScript and no-unused lint passed.
- Active-chain regression: all **33** flags execute successfully; right-scale
  and Link-arrow metadata queries return the expected database values.
- Fuzz: **200** duels, **97,740** decisions, **11,702** distinct deck cards;
  **15** completed, **184** reached the 500-decision cap, **1** reported unchanged
  visible state for 50 decisions (seed 20261003, decision 473).
  **0** Lua errors, **0** invalid CHAININFO errors, **0** worker crashes/timeouts.
- Audit: **14,736** cards checked, **13,988** scripts initialized, **748** normal
  monsters requiring no script, **322** alias scripts reused; **0** missing
  scripts and **0** load/initialization errors.

The fuzz stall is a remaining observation; a state fingerprint does not establish
whether the core or the harness caused it. Decision caps limit coverage and
are not successful duel completions. No other Lua errors were observed.
