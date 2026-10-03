# Ruling coverage and skipped-test disposition

Verified: 2026-10-02. This is the coverage ledger for sections 6 and 8 of
[the production-readiness plan](PRODUCTION-READINESS-PLAN.md), not a declaration
of exhaustive rules correctness or release readiness.

## Evidence model

`packages/engine/test/ruling-coverage.test.ts` adds **14 independent expected-outcome
assertions** against the real database, scripts, WASM core, and production adapters.
The expected LP, chain order, card locations, ownership, ATK, and permitted zones
are specified in the tests rather than copied from a second core run. Fixtures are
controlled board states, not tournament-legal deck lists; banned cards isolate
mechanics. A preplaced Link monster tests its arrows, not its summon procedure.

The existing untracked `rules-scenarios`, `timing-advanced`, `combat-windows`,
`revival-replay`, `helpers/controlled-duel`, and `native-reference` tests were
preserved without edits. Native differential comparison establishes parity with
a shared upstream core for its tested messages/queries; shared mistakes can still
agree. Script inspection helps explain behavior but is not an independent ruling
authority. Random duel completion is exercise coverage, not a ruling oracle.

## New independent outcomes

| Area | Explicit expected outcome | Reference |
| --- | --- | --- |
| Mandatory player choice (two variants) | Turn player can choose Sangan then Witch, or Witch then Sangan; resolution reverses the chosen chain | R1, R2 |
| Four-group SEGOC | Dark Hole produces turn-player mandatory Sangan, opponent mandatory Witch, turn-player optional Peten, opponent optional Peten as links 1–4; resolves 4–1 | R1, R2 |
| Declining an optional trigger | Declining Peten does not suppress mandatory Sangan; Peten stays in GY | R1, R3 |
| Activation negation and costs | Ash is already discarded before Divine Wrath responds; negating Ash's activation restores Pot of Greed's two-card draw, but neither Ash's nor Wrath's discard is refunded | R3, R4 |
| Immunity acquired after targeting; expiry | Chained Lance leaves Book's target face-up at 2200 ATK; next turn it is 3000 ATK again | R3, R5 |
| Control versus ownership | Snatch Steal transfers Blue-Eyes to controller 0 while owner remains 1; MST destroying the Equip returns control to 1 | R1, R6 |
| Tokens | Scapegoat creates four 0/0 Defense Position tokens; Dark Hole removes them entirely, not to GY | R1, R3 |
| Overlay disposal | Compulsory returns Utopia to Extra, not hand; its two materials go to GY | R1, R3 |
| Face-up Extra Pendulum zones (two variants) | Without arrows only one Odd-Eyes reaches an Extra Monster Zone; Decode Talker in left EMZ permits two simultaneous face-up Extra Pendulums in main zones 0 and 2 | R1, R7 |
| Continuous modifier | United We Stand gives Blue-Eyes 4600 ATK with two face-up friendly monsters, then 3800 when Book flips the other monster | R8 |
| Counters and costs | Normal Summoned Breaker gains one Spell Counter and reaches 1900 ATK; activating destruction spends it immediately and returns ATK to 1600 | R9 |
| Protection scope | Marshmallon survives battle with Blue-Eyes while its controller takes 2700 damage; Raigeki subsequently destroys it | R10, R1 |

The Pendulums are first destroyed on the field with Offerings to the Doomed so
their face-up Extra status is produced through actual movement, not assumed from
an initial Extra Deck fixture. The linked test checks the actual destination
sequences, not merely that two monsters were summoned.

## Verified references

The following references were retrieved or checked by web search on the date
above. Official rules/card text take precedence; historical community sources
describe their respective historical formats, not modern tournament policy.

- **R1:** [Konami official rulebook, version 10](https://img.yugioh-card.com/en/downloads/rulebook/SD_RuleBook_EN_10.pdf), sections on simultaneous effects, chains, tokens, ownership/control, Xyz materials, and Pendulum/Link zones. Version 10 predates the 2020 relaxation for Fusion/Synchro/Xyz monsters; its Link/face-up Pendulum restriction remains relevant, not its old restriction for all Extra Deck monsters.
- **R2:** [Konami fast-effect timing](https://www.yugioh-card.com/en/play/fast-effect-timing/) and [YGOrganization SEGOC explanation](https://ygorganization.com/learnrulingspart3/). The rulebook explicitly orders turn-player mandatory, opponent mandatory, turn-player optional, opponent optional, with choice within each group. The tested triggers are public GY effects, not the TCG/OCG private-hand-trigger divergence.
- **R3:** [Konami official card database](https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=1&request_locale=en), corresponding card texts; local official scripts were inspected for Peten's banish cost, Ash's discard cost/effect negation, Scapegoat, and Compulsory. For the cost/activation distinction also see the rulebook's activation and chain rules. These tests are deliberately narrower than every card-specific exception.
- **R4:** [Official Divine Wrath text](https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=1&pid=13312001&request_locale=en&rp=99999&sess=1): discard before the semicolon, then negate activation and destroy.
- **R5:** [Official Forbidden Lance text](https://www.db.yugioh-card.com/yugiohdb/card_search.action?keyword=Forbidden+Lance&ope=1&request_locale=en): loses 800 ATK and is unaffected by other Spells/Traps until the end of the turn.
- **R6:** [Official Snatch Steal text](https://www.db.yugioh-card.com/yugiohdb/card_search.action?keyword=Snatch+Steal&ope=1&request_locale=en): Equip-only control effect. Ownership remains with the original owner under R1.
- **R7:** Decode Talker's printed bottom-left/bottom-right arrows and R1's linked-zone restriction; the local database and controlled test verify the left-EMZ destination geometry.
- **R8:** [Official United We Stand text](https://www.db.yugioh-card.com/yugiohdb/card_search.action?keyword=United+We+Stand&ope=1&request_locale=en): 800 ATK/DEF per face-up monster controlled.
- **R9:** [Official Breaker text](https://www.db.yugioh-card.com/yugiohdb/card_search.action?keyword=Breaker+the+Magical+Warrior&ope=1&request_locale=en): one counter on Normal Summon, 300 ATK per counter, counter removal before target/destruction resolution.
- **R10:** [Official Marshmallon text](https://www.db.yugioh-card.com/yugiohdb/card_search.action?keyword=Marshmallon&ope=1&request_locale=en): cannot be destroyed by battle. The tested monster starts face-up, so its face-down-only burn trigger does not apply.

## Historical formats: limited evidence, unresolved compatibility

`src/formats.ts` advertises GOAT and Edison, both with MR1 and whitelists.
The existing `formats.test.ts` tests both with synthetic whitelists, verifying
MR1 core flags, five opening cards plus the first-turn draw, and whitelist rejection.
The real-list test reports **Edison unavailable in this upstream checkout**.
This is format configuration coverage, not historical card-ruling certification.

Inspection found that `makeScriptReader` searches `official` before `pre-errata`
and `goat` for every format, and `createDuel` does not select a historical script
reader. Thus historical names and MR1 flags alone do not prove old card behavior.
For example, modern Sangan's search restriction is not the historical Sangan
effect. Historical script selection needs an explicit policy and regression tests
before these formats can be advertised as faithful reproductions.

Verified historical references:
- [GOAT basic mechanics](https://www.goatformat.com/basics.html): first-turn draw, ignition priority, historical deck limits.
- [GOAT Sangan rulings](https://www.goatformat.com/rulings7.html): historical search wording and owner receiving the GY trigger after control changes.
- [Edison relevant errata](https://www.edisonformat.com/rulings/relevant-errata): Sangan permits activating the searched monster's effects.
- [Edison priority](https://www.edisonformat.com/priority.html) and [rule differences](https://www.edisonformat.com/edison-rule-differences.html): ignition priority and early-trigger ordering. Neither is certified by the modern SEGOC cases above.

GOAT's unlimited historical Fusion Deck/Main Deck also differs from this registry's
15/60 limits. Decide whether to document intentional simulator limits or implement
faithful limits. Speed Duel skill-card behavior and every TCG/OCG regional timing
difference remain outside this ledger's certification.

## Remaining section-6 gaps

- Damage Step: existing combat tests cover flip timing and ordinary MST exclusion,
  but not every start/before-calculation/calculation/after-calculation/end subwindow
  or each activation-negation/stat-modification exception.
- SEGOC: optional player group order and mandatory within-group choice are covered;
  multiple optional effects within one player's group, private hand triggers, and
  historical early triggers still need dedicated fixtures.
- Moving targets: existing Book/Compulsory test covers a target leaving the field;
  leave-and-return identity, resolution-time replacement, and multiple targets are
  not exhaustively covered.
- Continuous modifiers, end-turn expiry, battle protection, counters, tokens, and
  overlays have concrete examples. Destruction replacement/redirection, immunity
  by effect type/controller, reset on all location/position/control changes, and
  interactions between multiple modifiers remain gaps.
- Hidden-information tests exist separately (`prompt-privacy` and server spectator
  privacy); this new ruling file does not certify every reveal/search/random-hand
  interaction. Complex archetype combo decks still need card-specific sourced cases.
- No assertion here establishes complete natural browser gameplay, all matches,
  all scripts, all formats, or release-stress completion.

## Baseline seven skipped tests (section 8)

The baseline seven are guarded by `YGOSIM_TEST_ENGINE`, not permanently disabled
ruling tests. The command below enables their **unchanged assertions**. Existing
test files were not edited because ownership lies with other tasks.

| Baseline test | Enabled-run outcome | Disposition |
| --- | --- | --- |
| `server/test/banlist`: forbidden Pot of Greed and hundreds of TCG entries | Pass | Require data-backed real-engine job; can retain lightweight default gate |
| `server/test/format-validation`: reject Pot of Greed before room creation | Pass | Same |
| `server/test/integration`: reject TCG room over WebSocket | Pass | Require live-socket real-engine job |
| `server/test/integration`: complete AI game over WebSocket | Pass after transport-limit fix | Require live-socket real-engine job with unchanged assertions |
| `server/test/integration`: Bo3 versus AI with side decks | Pass after transport-limit fix | Require live-socket real-engine job with unchanged assertions |
| `server/test/integration`: real-engine Bo3 through lobby | Pass | Require real-engine job; does not establish passing AI Bo3 WebSocket flow |
| `server/test/spectator-privacy`: full real-engine duel hides both hands | Pass | Require real-engine privacy job |

The initial enabled run had 20 passing and 2 failing tests across the four files.
Both failures were independently reproduced as socket close code 1008 after a
strict 30-messages-per-second window rejected legitimate fast agent decisions.
The production transport now uses a finite burst token bucket instead of that
window; both unchanged WebSocket tests and all seven baseline gated cases passed
on rerun. This was a transport policy regression, not a core-ruling defect.

Other conditional tests are separate: real LFLists depend on data availability;
the MCP JSON-lines test is skipped only in its restricted in-memory mode;
`native-reference.test.ts` is opt-in without `YGOSIM_NATIVE_REFERENCE`. They are
not included in the baseline seven and need their own configured jobs.

## Reproduce and verification

```sh
pnpm --filter @ygosim/engine lint
pnpm --filter @ygosim/engine exec vitest run \
  test/ruling-coverage.test.ts test/rules-scenarios.test.ts \
  test/timing-advanced.test.ts test/combat-windows.test.ts \
  test/revival-replay.test.ts test/formats.test.ts

YGOSIM_TEST_ENGINE=1 pnpm --filter @ygosim/server exec vitest run \
  test/banlist.test.ts test/format-validation.test.ts \
  test/integration.test.ts test/spectator-privacy.test.ts
```

Engine lint passed; the six selected engine files passed **90/90 tests**, including
14/14 new ruling cases. The initial server command failed, then passed after the
transport fix documented above. Section 6 remains partially covered; all seven
baseline real-engine skips have now been exercised successfully. Full workspace,
browser, stress, and native results are tracked separately in the readiness plan.
