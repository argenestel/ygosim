# Rules and complex-deck audit — 2026-10-02

## Verdict

**Not ready to claim that all rules or all gameplay work.** The tested core rulings generally behave correctly, but the UI, event adapter, and bots have confirmed defects. This audit adds reproducible tests; it does not change production rules or fix those defects.

## Method and limits

- Ran the existing engine, server and MCP suites.
- Added controlled real-card scenarios using the actual local card DB, official Lua scripts, vendored WASM core, and production prompt/response/state adapters. No card scripts or rules are mocked in the new scenario tests.
- Controlled openings deliberately bypass deck construction and banlists to isolate rulings (e.g. Pot of Greed versus Ash). They are not claimed to be tournament-legal decks.
- Ran shuffled, TCG-validated sample decks through the production `createDuel` path and real bots, plus random-deck fuzzing.
- Existing server tests include mocked games; their passing results alone do not establish rules correctness.
- Expected outcomes are explicit card/rule assertions. This is **not** an exhaustive comparison with an independent rules engine, judge database, or every current card FAQ.
- Script audit checks compilation and `initial_effect`, **not every effect at runtime**.
- Headless core stress tests do not prove that every interaction is usable through the browser. Earlier browser tests reached turn 9 and found the tribute UX defect; the new bulk tests exercise the core/server directly.

## Results

### Existing baseline

292 tests passed; 7 skipped before adding audit regressions.

### Added regressions

Final full run: 329 tests reported passed, including 5 expected-failure regressions; 7 skipped. In other words, 324 ordinary passes and 5 confirmed defect expectations. Engine lint/typecheck, server typecheck, and web production build also passed.

33 engine scenarios plus 4 real-core server/room regressions. **Five are explicitly marked `it.fails` for known defects**, so a green test run must not be mistaken for those defects being fixed:

- One Ritual Summon event-classification failure.
- Four Normal/Hard bot/room failures with Blue Eyes and Utopia (seed 42).

### Card-script initialization

- 14,736 TCG/OCG card records checked.
- 13,988 scripts loaded and initialized.
- 748 ordinary Normal Monster records require no script.
- 322 records reuse alias scripts.
- **0 missing scripts; 0 initialization errors.**

### Random-deck stress

100 duels, 93,565 decisions, 8,450 distinct deck-card passcodes:

| Outcome | Count |
| --- | ---: |
| Natural completion | 60 |
| 1,200-decision cap | 38 |
| Unchanged state for 50 decisions | 2 |
| Lua / response encoding exceptions | 0 |

Caps are inconclusive, not proof of a bug. Both unchanged-state cases were interactive `select_card` material-selection decisions; selection/unselection can legitimately leave the board unchanged. Treat these as driver-indecision candidates, not proven core hangs.

### Complex sample decks

Decks: Blue Eyes Fusion, Junk Synchro, Link Code Talker, Utopia Xyz.

48 random legal-response games: all 16 ordered deck pairings, seeds 11/42/137.
8 additional real-bot games: each sample versus Blue Eyes, Normal/Hard, seed 42.

| Mode | Completed | Non-progress cutoff | Invalid bot responses |
| --- | ---: | ---: | ---: |
| Random legal-response driver | 47 | 1 | 0 |
| Normal | 2 | 0 | 2 |
| Hard | 2 | 0 | 2 |

54,988 decisions overall; 78 distinct card passcodes selected/activated.
The random-driver non-progress case was Link Code Talker versus itself, seed 11: repeated material selection/unselection, not an established engine hang.

Across these games: 75 Fusion, 85 Synchro, 205 Xyz, 239 Link summon events, 485 attacks, 344 damage events, and 1,893 resolved chain links.
These counts demonstrate exercised paths, **not exhaustive proof of the rulings of each card**.

## Confirmed rule scenarios

- Chains resolve last-in-first-out.
- MST destroying an activated Normal Spell does not negate it.
- Destroying a Continuous Spell before resolution stops its search effect.
- Book of Moon loses its target if chained Compulsory returns that target to hand.
- Solemn Judgment pays half LP and negates spell activation.
- Spell Speed 2 MST cannot respond to a Counter Trap.
- Normal-summon negation precedes successful-summon triggers; Torrential is not offered in the summon-negation window.
- Torrential is offered after a successful summon, before ignition actions.
- Optional “when” Peten misses timing when tributed; mandatory Sangan still triggers.
- Simultaneous mandatory Sangan/Witch triggers build a separate chain after destruction resolves.
- Ash negates drawing and its hard once-per-turn applies across copies.
- Veiler is available in opponent Main Phase, including its end window, but not Battle Phase.
- Mirror Force responds to attack declaration; MST destruction does not negate it.
- Flip effects resolve after the monster is flipped during battle; Man-Eater Bug destroys its target after calculation.
- Ordinary MST is unavailable in the tested damage-step flip-effect chain windows.
- Book of Moon stopping an attacker prevents damage.
- An attack-target removal offers a replay and permits choosing the surviving target.
- Twin Burst's second monster attack does not allow a second direct attack.
- Attack/Defense Position damage and battle destruction.
- One Normal Summon per turn, no first-turn Battle Phase, and newly set Quick-Play activation restriction.
- Level 8 requires two tributes; rejected responses preserve the pending prompt for retry.
- Fusion, Synchro, Xyz (including two attached materials), and Link material consumption and event types.
- Synchro without a tuner, Xyz with mismatched levels, and Link with disallowed Normal materials are not offered.
- Ritual activation is unavailable with insufficient tribute levels.
- Pendulum scales exclude boundary levels; a used Pendulum goes face-up to Extra rather than GY; a second Pendulum Summon is unavailable that turn.
- Monster Reborn cannot revive the tested improperly summoned Fusion/Synchro/Xyz monsters.

Ritual summoning itself succeeds in the core, but its event type is wrong (below).

## Confirmed defects

### 1. Tribute UI does not communicate weighted requirements

Browser: a Level 8 summon showed `Select 0–2` and allowed Confirm with one ordinary tribute. Server rejected it: `tributes provide 1, need at least 2`.

Source: `packages/engine/src/prompts.ts` publishes count bounds while keeping tribute-value checks in its response validator; `apps/web/src/duel/PromptPanel.tsx` only enforces those count bounds. A single double-tribute monster can be valid, so simply forcing a two-card minimum is not a complete fix. The UI needs the weighted requirement and a compatible validity check.

### 2. Normal/Hard bots do not satisfy engine-specific selection constraints

Complex-deck reproductions (seed 42):

- Blue Eyes versus Blue Eyes: `tributes provide 0, need at least 2`.
- Utopia versus Blue Eyes: `expected 1-1 choices` during the Utopia Ray special-summon flow.

`NormalBot` chooses using structural min/max and score alone; `HardBot` inherits that behavior. Structural legality does not establish weighted-tribute or interactive-selection legality. `Room.resolvePrompt` retries then falls back to defaults/singletons, which also cannot reliably supply multiple required tributes. Real-room regressions confirm that these matchups do not finish without rejected actions.

### 3. Normal bot can fail to progress

Earlier Chromium E2E: opponent turn 2/Main Phase 1 repeatedly emitted empty updates, while the browser showed “Opponent is thinking…”. This occurred after successful Dictator/Blue Eyes actions. The browser opening was not seeded, so this particular stall is not a deterministic rules regression yet. Do not attribute it to a specific card without a reproducible seed/action trace.

### 4. Ritual Summon misclassified by event adapter

Black Luster Ritual successfully tributes Blue Eyes and summons Black Luster Soldier. The production `DuelTracker` emits `kind: "special"`, not `"ritual"`.

The adapter notes that the retained decoder omits the summon reason. Its Extra Deck fallback recognizes Fusion/Synchro/Xyz/Link, but cannot reliably distinguish a Ritual Summon from an ordinary revival using card type alone. Core legality passed; client-facing classification did not.

## Not exhaustively tested

Every card-specific exception; all alternate chain-building orders and optional SEGOC choices; every simultaneous effect ordering; all Damage Step subwindows; every continuous modifier/immunity interaction; all historical formats; link-arrow restrictions on multiple face-up Extra Deck Pendulum summons; complex control/ownership changes; side-deck/match browser flows; disconnected-client recovery; every UI card/zone interaction.

The remaining seven skipped baseline tests still represent coverage gaps. The suite and successful script audit do not justify calling this fully rules-complete.

## Reproduce

```sh
pnpm test
pnpm --filter @ygosim/engine lint
pnpm --filter @ygosim/server typecheck
pnpm --filter @ygosim/web build

pnpm --filter @ygosim/engine exec vitest run \
  test/rules-scenarios.test.ts test/timing-advanced.test.ts \
  test/combat-windows.test.ts test/revival-replay.test.ts
pnpm --filter @ygosim/server exec vitest run test/real-bot-regressions.test.ts

pnpm --filter @ygosim/server exec tsx \
  ../../packages/engine/scripts/audit-scripts.ts \
  --output /tmp/ygosim-review/script-audit.json
pnpm --filter @ygosim/server exec tsx \
  ../../packages/engine/scripts/fuzz-duels.ts \
  --duels 100 --seed 20261201 --decision-cap 1200 --timeout-ms 15000
pnpm --filter @ygosim/server exec tsx \
  ../../packages/engine/scripts/rules-stress.ts \
  /tmp/ygosim-review/complex-decks.json
```

Detailed logs and script/complex-deck reports: `/tmp/ygosim-review/`.
Random-deck fuzz report: `packages/engine/data/reports/fuzz.json` (generated/ignored).
