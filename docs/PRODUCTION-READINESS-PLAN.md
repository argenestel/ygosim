# Production-readiness update plan

Date: 2026-10-03
Status: **Readiness fixes implemented and locally verified for the declared scope. Full-suite CI and deployment approval remain open; not certified for all advertised modes.**

## Implementation evidence

The shared protocol now carries tribute weights, mandatory/alternative sums, counter exclusivity, cancellation, and interactive selection actions. Engine validation remains authoritative; the browser, bots, room fallback, and agent bridge use the same selection validity contract. Confirm reflects actual contribution rather than card count alone.

The Ritual-label regression is fixed using authoritative procedure metadata, with real-core revival, Pendulum, and contact-summon assertions. A read-only accessor was added to the vendored WASM wrapper; upstream rules sources and transport/query layouts are unchanged. The rebuilt source archive and artifact hashes were checked against the pinned upstream revision. The native comparison passed 57 assertions and all 16 ordered seed-42 deck matchups completed naturally, with zero transport/query mismatches. These are differential checks against shared rules, not independent proof of every ruling.

Server hardening adds request-shape validation, room/socket/payload/message-rate limits, serialized room mutations, readiness checks, protected local agent controls, and shutdown cleanup. Agent reservations no longer seat dummy occupants or start a duel before the agent connects; two actual MCP clients joined a reserved room and finished naturally with no rejected actions. Unattended waiting rooms and previous completed rooms are reclaimed. Browser failures now have a terminal recovery screen instead of a dismissible error followed by perpetual thinking. See [deployment and recovery](DEPLOYMENT.md) for configuration, anonymous-service boundaries, and restart limitations.

Public diagnostic tokens use a process-private HMAC key rather than plain hashes of private prompts, choices, or decks. Prompt identifiers bind action tokens to their original prompt; tokens remain comparable within that context but are not reproducible across process restarts. Restricted operator context retains the raw reproduction data separately. The focused progress/recovery suite passes all 13 tests, including token privacy, with server typechecking passing after this change.

Screenshot inspection found an additional usability defect: the image proxy duplicated the CDN's `cards` path, so face-up 3D cards remained blank placeholders. Both full/small paths are fixed, with real Node/CDN delivery verified and six cache tests covering deduplication, bounded queues/body size, retries, and shutdown cancellation. Invisible/back-only cards no longer fetch unused front art; board textures use the small endpoint. Fresh browser texture evidence is part of the final visual gate.

The bot matrix completed **144/144 games naturally**, covering every ordered pairing of the four sample decks, all three bot levels, and seeds 11/42/137, with no rejected responses or unexplained non-progress (`bot-matrix-final.json`, generated 2026-10-02T12:51:04Z). The isolated eight-room probe completed 8/8 games with no rejections; its measured event-loop p99 was 82 ms and maximum 356 ms, with a 346 ms maximum heartbeat delay (`concurrent-bots-final.json`, generated 2026-10-02T12:57:53Z). The concurrency phase inside the longer matrix instead measured p99 192 ms, maximum 193 ms, and a 410 ms heartbeat delay. These measurements are not a sub-100-ms availability guarantee or a capacity certification for the room limit.

The maintained `pnpm test:stress` command was then exercised successfully on 2026-10-03: **144/144 completed**, followed by **8/8 natural room outcomes**, zero rejected room actions, and no failures. Its archived `artifacts/bot-matrix.json` records a 73 ms event-loop p99/maximum and 186 ms maximum heartbeat delay for that concurrency phase. Different probe results are preserved rather than presented as a universal latency bound.

The original full browser run passed 12/16 cases; the repaired six-case run covers all four original failures plus the new SideDeck component case. Together they provide passing evidence for all 17 unique cases, not a single clean 17-case invocation. Subsequent visual review caught the missing SideDeck card-grid styles. Bounded responsive card sizing, non-shrinking sections, sticky Ready/Reset controls, and accessible selection state were added. A fresh component rerun passes desktop/mobile size bounds, real loaded art, selection toggling, and rejection/retry; the web build and E2E typecheck pass after this final UI change.

All seven previously skipped real-engine baseline cases passed with their assertions unchanged. Their first enabled run exposed a transport policy regression: a strict 30-message window disconnected fast agents. A finite burst token bucket fixed it without exempting arbitrary action traffic from abuse limits. The 1.5-second seed-42 cutoff is preserved; package/server-file test concurrency is serialized so release checks do not deliberately compete for CPU.

The script audit initialized **13,988 scripts**, checking 14,736 database cards, with zero missing scripts or initialization errors. Random fuzzing with the default 500-decision cap had 4 completions and 16 inconclusive caps; the explicit 4,000-decision release budget completed the same 20 seeds naturally in 19,793 decisions with no errors. The initial caps were not counted as successful games or attributed to a core hang.

The fresh combined non-browser release gates pass: **248 engine tests**, **31 MCP tests**, and **130 enabled server tests**, plus engine lint, server/MCP typechecks, production web build, browser-harness typecheck, and diff validation. The default lightweight test run passes 122 server tests and still skips the opt-in native case and eight server data-backed cases; the enabled integration gate runs all 130 server assertions, including the seven original skips and the new real MCP-agent connection case. This combined run includes the latest side-deck conservation/retry and keyed-diagnostic changes. Fresh provenance records the dirty worktree explicitly; no commit or deployment is implied. The web build still warns about a large duel-screen chunk, so it is not evidence of acceptable production bundle performance.

Maintained browser tests, CI, and 14 additional independent high-risk ruling assertions are implemented. Browser verification exposed driver defects: incorrect pile-option indexing, ambiguous duplicate procedure labels, initial rendered-target readiness, and an arbitrary eight-repeat guard that rejected legitimate Damage Step windows. The driver now uses actual card UIDs/action IDs, waits for rendered targets, and reuses production NormalBot/BotProgress. Duplicate menu procedures have distinguishable labels. The repaired six-case run passed XYZ, all four natural games, and the SideDeck error-prop/Ready-retry component fixture; its preserved report and screenshots are in `artifacts/browser-final-repaired`. Natural seed-42 games finished in 288/357/377/396 actions respectively (Blue Eyes/Junk/Utopia/Link), all below the unchanged 500-action and 600-second limits, with visible natural result headings and displayed LP matching state. This is targeted repair evidence, not a clean single full-suite run. Natural-duel tests use a DEV-only reduced-cosmetic mode that disables shadows/postprocessing while preserving geometry, camera, animations, and pointer handlers; controlled visual cases retain normal rendering. See the [ruling coverage ledger](RULING-COVERAGE.md) for sourced expected outcomes, historical-format risks, and remaining coverage gaps. No aborted or capped duel counts as a successful game.

## Goal

Make legal gameplay usable and reliable through the browser, bots, and agent API. Preserve the existing upstream rules core unless a reproducible core defect requires a change.

Evidence:
- [Rules audit](RULES-AUDIT.md)
- [EDOPro native-core comparison](EDOPRO-COMPARISON.md)

The native comparison found no differences in tested raw messages/queries. It does not establish exhaustive rules correctness or validate the whole application. Passing script initialization is not proof that all card effects work at runtime.

## Priority order

| Priority | Update | Status |
| --- | --- | --- |
| P0 — release blocker | Shared engine-specific selection constraints and tribute UI | Verified shared legality and ordinary/double-tribute browser cases |
| P0 — release blocker | Valid bot decisions and bounded room recovery | Verified focused regressions, combined gates, and maintained 144-game matrix |
| P0 — release blocker | Reproduce and resolve bot non-progress | Bounded detection added; historical unseeded incident still cannot be reproduced |
| P1 — required before release | Correct summon-event classification | Verified, including legal revival and native comparison |
| P1 — required before release | Persistent browser E2E and expanded timing tests | 17 unique cases have split-run passing evidence; unverified modes explicitly excluded |
| P1 — required before release | Error handling, lifecycle checks, diagnostics | Boundary/lifecycle regressions pass; eight-room responsiveness measured with explicit limits |
| P1 — release process | CI gates and reproducible reference comparisons | Local scoped checks pass; clean full-suite run and GitHub execution remain open |

P0 items should be implemented first. P1 is not optional for declaring production readiness.

## 1. Shared selection constraints and tribute UX

### Problem

A Level 8 summon displays `Select 0–2`, enables Confirm for one ordinary tribute, and is then rejected by the engine. Count bounds alone do not represent tribute values, weighted sums, or interactive material-selection requirements.

### Changes

- [x] Define serializable prompt constraints in `packages/protocol/src/index.ts`.
- [x] Expose the relevant tribute values/required total from `packages/engine/src/prompts.ts`.
- [x] Cover weighted sums and interactive select/unselect/finish/cancel decisions, not just plain card counts.
- [x] Use one reusable selection-validity implementation wherever possible: browser, bots, room fallback, and agent tooling.
- [x] Keep the engine's response validator authoritative; clients must not bypass it.
- [x] Update `apps/web/src/duel/PromptPanel.tsx` to show the actual requirement and selected contribution.
- [x] Disable Confirm for an invalid selection and explain what is missing.
- [x] Preserve the current prompt and allow a valid retry after rejection.
- [x] Review equivalent handling in `packages/mcp` so agents can understand the same constraints.

**Do not simply set a two-card minimum:** one double-tribute monster can legally satisfy a two-tribute requirement. Also preserve selection privacy: constraint metadata must not reveal hidden card identities or stats.

### Acceptance

- Two ordinary tributes succeed; one ordinary tribute cannot be confirmed in the UI.
- A permitted double-tribute monster succeeds alone.
- Mandatory materials, weighted sums, finish/cancel, and interactive selections behave correctly.
- Invalid/stale responses remain rejected; a subsequent valid response succeeds without losing the prompt.
- Unit tests, real-core tests, and browser tests cover these cases.

## 2. Valid bot decisions and room recovery

### Problem

Normal and Hard bots generate structurally valid but engine-invalid selections. Reproductions at seed 42 include:

- Blue Eyes versus Blue Eyes: `tributes provide 0, need at least 2`.
- Utopia versus Blue Eyes: `expected 1-1 choices` during the Utopia Ray summon flow.

The room's fallback tries defaults and single options, which cannot reliably solve multi-card requirements.

### Changes

- [x] Update `packages/server/src/ai/normal.ts` and inherited Hard behavior to use the shared constraints.
- [x] Review Easy bot and `packages/server/src/ai/bot.ts` defaults for the same limitations.
- [x] Separate strategic scoring from legal candidate generation.
- [x] Generate valid combinations for tributes/materials rather than assuming one highest-scored option is sufficient.
- [x] Handle interactive selections as progress toward a valid finish; avoid repeated select/unselect or cancel/retry loops.
- [x] Update `Room.resolvePrompt` in `packages/server/src/room.ts` to use constraint-aware fallback.
- [x] Bound retries/search by explicit budgets; retain diagnostics when no acceptable response is found.
- [x] Fail visibly and cleanly rather than leaving a room apparently active indefinitely.

### Acceptance

- Remove `it.fails` from all four cases in `packages/server/test/real-bot-regressions.test.ts` only after the underlying failures are fixed.
- Seed-42 Blue Eyes and Utopia matchups finish naturally, without rejected bot responses, aborted rooms, or timeout-driven test shutdown.
- Run all four sample decks in both seats against Easy/Normal/Hard across multiple seeds.
- Unexpected validation errors are retained as test failures, not silently hidden by fallback.

## 3. Bot non-progress diagnosis and prevention

### Problem

Browser gameplay showed the Normal bot staying at turn 2/Main Phase 1 with repeated empty updates. That opening was not seeded. The precise cause is not yet established.

Random stress drivers also produced material-selection loops; these are not automatically evidence of core hangs.

### Changes

- [x] Capture duel seed, deck versions, current prompt, both relevant state snapshots, and action trace in restricted server-operator diagnostics; generate a retained seed for new unseeded rooms.
- [x] Record internal selection progress as well as board progress; a legal material selection can leave the board unchanged.
- [ ] Turn the browser observation into a deterministic regression before attributing it to a card or scoring rule.
- [x] Audit repeated shuffle, position-change, activation, cancel, and selection actions that do not advance play.
- [x] Add bot action budgets and progress detection with an explicit recovery/error policy.
- [x] Keep meaningful progress detection separate from a simple wall-clock deadline.
- [x] Show an actionable browser error/recovery state instead of perpetual “Opponent is thinking…”.

### Acceptance

- Original behavior is reproducible and then demonstrably fixed.
- Valid long chains and interactive selections do not trigger false stall detection.
- A deliberately looping test bot is detected; room shutdown releases the duel and pending waits.
- No unexplained non-progress in the release stress matrix; inconclusive caps are documented rather than counted as successful games.

## 4. Correct summon-event classification

### Problem

Black Luster Ritual correctly summons Black Luster Soldier in the core, but the event adapter reports `kind: "special"` instead of `"ritual"`.

### Changes

- [x] Preserve the authoritative summon reason/type through the core decoder/compatibility boundary where available.
- [x] Update `packages/engine/src/state.ts` to classify from that information.
- [x] Avoid guessing solely from card type: reviving a Ritual/Fusion/Synchro/Xyz/Link monster is not necessarily that summon procedure.
- [x] Review Pendulum and contact-summon event classification for equivalent gaps.
- [x] Review existing animation/audio/log/agent consumers for these kinds; browser animation coverage remains a separate gate.

### Acceptance

- Remove the Ritual case's `it.fails` in `packages/engine/test/rules-scenarios.test.ts` after it passes normally.
- Ritual procedure emits `ritual`; an ordinary legal revival of a Ritual monster emits `special`.
- Existing Extra Deck summon and revival classifications remain correct.
- Native reference comparison remains mismatch-free at the transport/query level.

## 5. Persistent browser end-to-end suite

The earlier Chromium scripts/logs under `/tmp` are disposable. Move important flows into maintained repository tests with documented browser dependencies.

- [x] Launch isolated frontend/server instances on free ports and clean them up after tests.
- [x] Use deterministic seeds and fresh browser storage.
- [x] Test real clicks on 3D cards, action menus, zones, and multi-selection Confirm controls; do not validate usability only through development hooks.
- [x] Cover all four sample decks: Fusion, Synchro, Xyz, Link.
- [x] Add Ritual and Pendulum browser fixtures.
- [ ] Exercise chains, target selection, costs, tributes, attack replay, LP updates, and natural win/loss screens.
- [x] Test surrender, return, and starting another duel in the same session.
- [x] Cover mobile/touch targeting, resizing, and keyboard interaction at smoke-test scope.
- [ ] Exercise room creation/joining, spectator privacy, agent play, Best-of-3/side-deck flows, and client disconnects.
- [x] Fail on unexpected page errors, server errors, stale prompts, or missing state progress.
- [x] Save screenshots, action traces, console output, and server logs on failure.

### Acceptance

Every supported release mode has a repeatable passing smoke flow. At least one complete natural duel per complex sample deck is verified through browser interaction, not just headless core calls.

## 6. Expand ruling coverage

Existing real-script scenarios already cover many fundamental rulings. Add explicit expected outcomes for the remaining high-risk areas:

- [ ] Optional and mandatory simultaneous-trigger ordering, including player choice/SEGOC variations.
- [ ] Every supported Damage Step subwindow and activation restriction.
- [ ] Activation negation versus effect negation; costs, targets, and resolution when cards move or become immune.
- [ ] Continuous modifiers, replacement effects, protection, and effects that expire/reset.
- [ ] Link-arrow restrictions for multiple face-up Extra Deck Pendulum summons.
- [ ] Ownership/control changes, overlays, counters, tokens, and hidden-information handling.
- [ ] Card-specific interactions from additional complex archetype decks, with verified ruling references.
- [ ] Historical/master-rule formats actually advertised by the product.

Record the source of expected rulings and distinguish shared-core differential checks from independent ruling assertions. Do not claim exhaustive support from random-game completion alone.

## 7. Operational reliability and diagnostics

These are readiness checks, not all confirmed defects.

- [x] Make connection/server failures and duel aborts visible and recoverable.
- [x] Define reconnect behavior explicitly: sessions cannot resume; return to the menu to start again.
- [x] Release WASM handles, sockets, timers, and pending prompts on tested shutdown, abort, timeout, surrender, and siding paths.
- [x] Validate requests at boundaries and retain stale-prompt protection.
- [x] Retain structured rejected-action, fallback, timeout, abort, and progress diagnostics; raw reproduction context is operator-only.
- [x] Keep shuffle seeds and raw reproduction context out of public diagnostics; client-facing errors use fixed sanitized classifications.
- [x] Apply/verify room, socket, and message-size limits before exposing the service publicly.
- [x] Measure multi-room CPU/memory behavior and responsiveness during long synchronous engine workloads; single core calls remain uninterruptible.
- [x] Document deployment configuration, health checks, supported modes, and recovery limitations.

## 8. CI and release gates

### Required commands

```sh
pnpm test
pnpm --filter @ygosim/engine lint
pnpm --filter @ygosim/server typecheck
pnpm --filter @ygosim/web build
```

### Scheduled or pre-release checks

```sh
bash packages/engine/scripts/reference/build-native-reference.sh
YGOSIM_NATIVE_REFERENCE=/tmp/ygosim-reference/build/libocgcore.so \
  pnpm --filter @ygosim/engine exec vitest run test/native-reference.test.ts

pnpm --filter @ygosim/server exec tsx \
  ../../packages/engine/scripts/rules-stress.ts
```

`pnpm test:stress` writes the 144-game matrix and eight-room probe to `artifacts/bot-matrix.json` and fails on incomplete games or rejected room actions. `pnpm test:extended` includes it with the native comparison, script audit, and strict fuzz completion check; the scheduled/manual reference workflow archives these reports. This workflow configuration has not yet been executed on GitHub.

- [ ] Run maintained browser E2E in CI once introduced.
- [x] Execute all seven skipped baseline tests with `YGOSIM_TEST_ENGINE=1`; require the enabled integration gate in the release process.
- [ ] Keep the native-reference test opt-in locally, but execute it in a configured scheduled/release job.
- [ ] Archive reports with core, scripts, database, deck, seed, and build provenance.
- [ ] Run script audit and fuzzing after dependency/core/script updates.
- [ ] Remove expected-failure markers only with verified fixes; do not count them as working features.

## Release checklist

### Verified scope and exclusions

The evidence currently covers real-core sample-deck bot games, focused engine/protocol/privacy/lifecycle regressions, real MCP client connections, native differential checks, controlled browser procedures, and all four natural browser sample-deck games. A clean complete browser-suite run and a GitHub workflow run are still release-process requirements. Browser multiplayer, spectator privacy/interaction, complete best-of-three siding, and automatic Claude/Codex process launch are not end-to-end verified release features. The SideDeck component retry fixture is narrower than a complete match. Historical formats and the uncovered ruling families in the coverage ledger are also outside the verified scope. Accounts, authenticated agent identity, persistent reconnect, and distributed room routing are not implemented by this anonymous in-memory service.

A public deployment is not verified by these local results: no production deployment or GitHub workflow run has been proven. Scope exclusions must be reflected in advertised capabilities before a scoped release; recording them here does not silently certify the affected modes.

- [ ] All P0 and P1 items above are resolved or the affected feature is explicitly removed from release scope.
- [ ] No known invalid-selection, bot-stall, or summon-label defect remains in supported modes.
- [x] All five known-defect expected-failure regressions pass as ordinary tests.
- [ ] Core tests, type checks, build, browser E2E, and configured native comparison pass.
- [x] Complex-deck/bot stress matrix completes without unexplained aborts or non-progress.
- [ ] Privacy and lifecycle checks pass for players, spectators, and agents.
- [ ] Every remaining skipped test and coverage gap has a documented disposition.
- [ ] Deployment and recovery limits are documented and verified.

Meeting these gates supports release readiness for the tested, declared scope. It still does not justify a claim that every possible card interaction has been proven correct.
