# Script audit and duel fuzzing

Run from the repository root with a locally available `tsx`:

```sh
tsx packages/engine/scripts/audit-scripts.ts
tsx packages/engine/scripts/fuzz-duels.ts
```

Both use the existing engine data lookup (`YGOSIM_DATA`, otherwise the repository's `data/` directory). Reports always default to `packages/engine/data/reports/`, which is ignored by Git. No database, upstream script, or banlist files are modified.

The audit checks all loaded OCG/TCG records except Rush cards and tokens. Alternate artwork can reuse its alias's script. Plain normal monsters without scripts are counted separately; normal Pendulum monsters still require scripts. Cards are registered in batches of 500, using the core's script reader and error handler to test compilation and `initial_effect`. Card scripts cannot be loaded as generic helper scripts with `loadScript`: their `GetID()` function needs the card context supplied during registration. The audit does not exercise every effect operation.

The fuzzer defaults to 200 duels with seeds starting at 20261002. Main decks contain 40–60 random released TCG cards, Extra Decks contain 15, and Side Decks are empty. All decks pass the existing TCG validator, including the local LFLists banlist and alias/copy rules. The generator also excludes OCG-only, prerelease, Rush, token, and skill cards. It samples the whole eligible pool without enforcing archetype synergy.

```sh
tsx packages/engine/scripts/fuzz-duels.ts --duels 1 --seed 20261048
tsx packages/engine/scripts/fuzz-duels.ts --duels 200 --decision-cap 1000 --timeout-ms 60000 --stall-moves 100
tsx packages/engine/scripts/audit-scripts.ts --batch-size 100 --output packages/engine/data/reports/custom-audit.json
```

Random choices are submitted through the public `Duel` interface. The fuzzer retries only response-validation errors, with a bounded subset search for weighted selections. A `choice_search` outcome identifies a harness search limitation and can also expose a malformed prompt. Exceptions after response submission are preserved. Each duel is capped at 500 accepted decisions and 30 seconds of wall time by default. A separate parent process can terminate its own worker even when synchronous WASM stops returning. Workers reuse the database and WASM instance across duels and restart after a timeout/crash.

`fuzz.json` includes totals, error counts/types, ranked card contexts, unique deck-card coverage, seeds, failed decks, the last prompt, and the last 20 accepted choices. `decision_cap` means the duel stopped at the configured bound; it does not prove a hang. `no_progress` means the visible state did not change for 50 decisions (or the engine's processing cap fired). Neither result proves a card is broken. Card codes from Lua filenames are direct evidence; the last activated or selected card is only context. Shared utility/core incompatibilities can affect many otherwise valid cards.

For restricted environments where the `tsx` CLI cannot open its IPC pipe, run Node with the installed loader instead:

```sh
node --import tsx packages/engine/scripts/audit-scripts.ts
node --import tsx packages/engine/scripts/fuzz-duels.ts
```

Use an absolute path to `tsx/dist/loader.mjs` if `tsx` is only available in a local cache. This project adds no dependency for the audit tools.
