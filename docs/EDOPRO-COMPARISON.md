# EDOPro reference comparison — 2026-10-02

## Open-source simulators

- **[EDOPro / Project Ignis](https://github.com/edo9300/edopro)**: an open-source desktop Yu-Gi-Oh! simulator.
- **[YGOPro](https://github.com/Fluorohydride/ygopro)**: the open-source project from which this family of simulators derives.
- EDOPro's headless rules library: **[edo9300/ygopro-core](https://github.com/edo9300/ygopro-core)** (AGPL-3.0-or-later).

## What was actually compared

Built an **unmodified native Linux copy of EDOPro's upstream rules core** from a separate Git checkout, with its pinned Lua submodule. Compared it in lockstep against ygosim's WASM core and production message/query bridge.

- Core revision: `efc21aa433b88cd35b7c37db4072a35c58d9d435` (API 11.0).
- Lua revision: `6e22fedb74cf0c9b6656e9fce8b7331db847c605`.
- The native build lives in `/tmp/ygosim-reference/build/libocgcore.so`; it is not bundled into this repository.
- Both implementations received identical card data, official Lua scripts, starting positions, seeds, and serialized responses.
- Compared **raw message bytes before ygosim's compatibility normalizer**, process statuses, and raw card/zone query bytes (including stats and overlays).
- Existing rule assertions were run without changing the scripts or expected results. The already-known Ritual event-label defect remained an expected failure; an independent aggregate assertion required zero native/WASM mismatches, so an expected failure could not conceal a transport divergence.

**This did not launch EDOPro's full desktop GUI or test its network/UI behavior.** It is a headless native-core comparison, not a claim of full application equivalence.

## Results

| Check | Result |
| --- | ---: |
| Targeted rule scenarios | 33 exercised |
| Full complex-deck games | 16/16 naturally completed |
| Complex-deck decisions | 18,447 |
| Total controlled/native duel instances | 51 |
| Native/WASM processing steps compared | 40,819 |
| Raw card/zone query comparisons | 282,696 |
| Serialized responses mirrored | 18,897 |
| Raw message bytes compared | 1,037,411 |
| Native/WASM mismatches | **0** |

Four decks were tested in every ordered pairing at seed 42:

- Blue Eyes Fusion
- Junk Synchro
- Link Code Talker
- Utopia Xyz

The 33 targeted scenarios cover chains, Counter Trap speed restrictions, negation versus destruction, simultaneous triggers, missed timing, summon windows, main-phase timing, damage-step restrictions, combat, attack replay, extra attacks, weighted tributes, Fusion/Synchro/Xyz/Link/Ritual/Pendulum mechanics, and revival limits. See `docs/RULES-AUDIT.md` for the exact assertions.

The opt-in differential file reported 50 successful test expectations: 33 scenario expectations (one explicitly expected Ritual-label failure), 16 completed games, and the aggregate zero-mismatch assertion.

## Interpretation

The tested WASM core/message/query behavior agrees with a separately compiled EDOPro native core. No port divergence was found in these cases.

**This is not an independent proof that every Yu-Gi-Oh! ruling is correct.** The native and WASM implementations share the same upstream core revision and Lua card scripts. A bug in that shared logic may agree in both implementations. Nor does byte-level agreement validate ygosim's derived UI labels, choices, bots, or browser interactions.

The previously confirmed problems remain:

1. Tribute UI permits submissions that do not satisfy tribute-value requirements.
2. Normal/Hard bots generate invalid weighted or interactive selections; room fallback is insufficient for some cases.
3. A browser-observed Normal-bot non-progress case still needs a deterministic reproduction.
4. Ritual Summon is mislabeled as ordinary `special` by the event adapter, despite correct underlying core execution.

No production fixes were made by this comparison.

## Reproduce

Linux prerequisites: Git, g++, Ninja, Python 3, Node/pnpm and installed project dependencies.

```sh
bash packages/engine/scripts/reference/build-native-reference.sh

YGOSIM_NATIVE_REFERENCE=/tmp/ygosim-reference/build/libocgcore.so \
  pnpm --filter @ygosim/engine exec vitest run test/native-reference.test.ts
```

The build script fetches pinned sources, verifies their revisions and cleanliness, and does not reset an existing checkout. Lua is compiled as C++, as required for the core's exception handling. Native upstream license notices remain in that checkout.

Without `YGOSIM_NATIVE_REFERENCE`, the expensive external-reference test is intentionally skipped in the default suite. The 33 underlying scenario tests still run normally.

Reports/logs:

- `/tmp/ygosim-reference/differential-report.json`
- `/tmp/ygosim-reference/differential.log`
- `/tmp/ygosim-reference/default-tests.log`

`YGOSIM_REFERENCE_REPORT` can override the report filename. Reports/binaries under `/tmp` are disposable; these scripts and documents preserve the reproduction steps.
