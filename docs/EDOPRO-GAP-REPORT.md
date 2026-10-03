# ygosim → EDOPro feature-gap review

## Executive summary

**ygosim has a substantial playable foundation, not desktop EDOPro feature parity.** The highest-value work is making information and decisions legible (reveals, timing controls, logs), preserving games (replays/reconnect), improving deck discovery, and providing credible practice opponents. Do not spend the next milestone rebuilding already-present rooms, chat, siding, pile views, or ydke support.

**Main missing capabilities:** saved/watchable replays; puzzles and genuine solo hand testing; tag duels; host-defined rules; Rush; visible competitive clocks; full chain policies; persistent recovery; archetype executors; automatic, versioned data updates.

**Already present, sometimes incomplete:** format/banlist selection, singles/Bo3 and side decking, surrender, public room browser, code joining, live spectators, room chat, 3D pile inspection, name/effect-text search, attribute/race/exact-level filters, YDK/ydke import/export, and MCP/JSON-lines agent play.

### Scope, provenance, and estimates

Read-only code review, **2026-10-03**, including all six `docs/*.md`, web screens/duel components, engine/protocol/server/MCP sources, and freshly fetched upstream references. No ygosim files were modified and no builds/tests were run, avoiding interference with the other agent. Findings are implementation observations, not fresh runtime certification. The checkout can change after this review.

- ygosim HEAD at inspection: `ccb1848cf34f995019d62e65ae5a18fbb3ca21e4` (status output was clean at capture).
- EDOPro upstream HEAD: `c250b6ab9bebb6eca9fdd07ee0c5bd2278426e81`.
- WindBot upstream HEAD: `bffe6b62679c8b2fafea8f59740e03a132517da4`.
- Distribution upstream HEAD: `54a6e2395c532648ff762540e9615319fac4f51b`.
- References cloned to `/tmp/edopro-gap/{edopro,windbot,distribution}`. “Current” means these retrieved heads, not proof of what every installed release/server runs.

Paths below are relative to `/home/arg/projects/hack/ygosim` unless prefixed **E/** (EDOPro `gframe/`), **W/** (WindBot), or **D/** (Distribution). Upstream source links can be reconstructed as `https://github.com/edo9300/edopro/blob/<revision>/gframe/<file>` (similarly for WindBot/Distribution).

Priority: **P1** everyday usability/retention; **P2** breadth/practice/host flexibility; **P3** specialized modes or infrastructure-heavy extensions. Effort: **S** roughly 1–3 engineer-days; **M** 1–3 engineer-weeks; **L** 4+ weeks, often multiple milestones. Estimates include focused tests, not exhaustive card certification or all production infrastructure. Dependencies can increase them.

**Important comparator boundaries:** EDOPro's embedded/LAN server and public server ecosystem are different things. Its source verifies rematches, configurable timers, replay recording, spectators, and teams. It does **not** establish native ranked accounts, general disconnect-resume, or negotiated draw offers. Those are desirable Master Duel/online-service extensions, not automatically EDOPro parity gaps. Omega/MD proprietary deck-code integration likewise is not a verified standard EDOPro feature. EDOPro's timer is turn-budget based, not necessarily a whole-game chess clock.

## 1. Duel features

### 1.1 Saved replays and replay playback — P1 / L (stream-only MVP: M)

- **EDOPro:** records response-based and message-stream replays, saves `.yrpX`, opens/manages replay files, supports pause/step/undo and viewpoint changes. Evidence: **E/** `replay.cpp` (`BeginRecord`, `SaveReplay`, `OpenReplayFromBuffer`), `replay_mode.cpp`, `old_replay_mode.cpp`, `game.cpp` replay controls; `generic_duel.cpp` records server messages/responses.
- **ygosim:** no replay save/load/library protocol or replay screen. `apps/web/src/duel/useDuel.ts` queues ephemeral animations and applies events; that is **not a replay feature**. `packages/server/src/room.ts` retains only bounded diagnostic traces (32 entries), not a full duel recording. `packages/protocol/src/index.ts` has no replay message/API contract.
- **Impact:** players cannot review mistakes, share memorable games, study agent reasoning alongside a duel, or provide a complete incident reproduction.
- **Approach:** first persist a versioned, viewer-redacted event stream with periodic authoritative snapshots and a playback-only route using the existing animation pipeline. Include room/game IDs, options, result, timestamps, and data/core/build revision metadata. Pause/step/seek should work independently of live sockets. Separately retain restricted full response traces + seeds/decks for deterministic reproduction. Add EDOPro `.yrpX` import/export only as a later compatibility project, not by renaming JSON. Test playback after control changes, shuffles, reveals, and match transitions.
- **Privacy:** do not publish seeds, ordered hidden decks, or unrestricted operator traces during live games. Post-game omniscient replays require an explicit disclosure/consent policy; default shared replay should preserve its recorded viewpoint.

### 1.2 Card reveal/confirm presentation — P1 / M

- **EDOPro:** `MSG_CONFIRM_CARDS`, deck-top and Extra-top confirms get card displays/log entries; see **E/** `duelclient.cpp:2513–2608` and confirmation handling.
- **ygosim:** engine support is **partial but real**: `packages/engine/src/state.ts:215–216` converts confirm messages into audience-tagged `move` events with `reason: "reveal"`; deck-top visibility is also tracked. `apps/web/src/duel/useDuel.ts` treats a reveal as an ordinary move, then snaps to the redacted state. `DuelScreen.tsx` has inspector and ordinary pile modal, but no dedicated reveal/acknowledge/history UI. Hint events are explicitly skipped in `useDuel.ts`'s pump. A revealed opponent hand card may therefore be brief/easy to miss rather than deliberately presented.
- **Impact:** searches and hand/deck reveals can become practically unreadable; players miss strategically important information even though core rules execute.
- **Approach:** explicit reveal event with cards, recipient/public audience, source/effect context and presentation grouping. Add a reveal tray with inspectable cards and dismiss/acknowledge behavior; acknowledgement must be presentation-level unless the core actually requires a response. Preserve public/private reveal semantics through spectators and replay serialization; avoid permanently revealing cards after a subsequent shuffle. Cover private confirmation and public reveal separately.

### 1.3 Chain timing policies and chain-building preferences — P1 / M

- **EDOPro:** Ignore/Always/When Available buttons; automatic forced-chain ordering preference; timing/delay settings. **E/** `duelclient.cpp:2183–2217`, `game.h`, `settings_window.cpp`. “Always” permits stopping at otherwise skipped available core windows; it does not create illegal windows.
- **ygosim:** `DuelScreen.tsx` has persistent **Auto-pass** that only skips `select_chain` when no option has a card; turning it off lets such prompts surface. `ChainPanel.tsx` displays links; `PromptPanel.tsx` presents actual choices. There is no explicit Ignore/Always/Available policy or forced-order preference. `packages/engine/src/prompts.ts` maps core choices, but the shared `Prompt` contract does not carry EDOPro's richer trigger/forced/special-count timing metadata.
- **Impact:** experienced players cannot use familiar toggles/hold overrides; novices must answer too many prompts or misunderstand what Auto-pass actually does. SEGOC ordering is different from automatic passing and needs distinct controls.
- **Approach:** add safe per-viewer policies (Auto/On/Off or EDOPro labels), keyboard/touch temporary override, and descriptive tooltip. Preserve mandatory effects and trigger-order decisions; Off must only decline optional decisions. Publish enough core metadata to distinguish free-chain, trigger, mandatory, and no-action windows. Test Damage Step, empty windows, mandatory chains, optional SEGOC ordering, and stale action protection. Prefer one decision policy shared with agent clients rather than UI-label heuristics.

### 1.4 Field/duel log and LP history — P1 / M (basic log: S)

- **EDOPro:** visible logs/card references and confirmation/hint messages: **E/** `game.cpp`, `game.h` (`lstLog`), `duelclient.cpp` (`AddLog`); live LP updates/cost animations. This review did **not** verify a dedicated historical LP graph/ledger in desktop EDOPro.
- **ygosim:** web only has the short room chat log and transient effects in `DuelScreen.tsx`/`useDuel.ts`; `hint` is discarded, effect objects expire, and no duel-log panel exists. LP damage/recovery/cost events already exist in `packages/protocol/src/index.ts` and `packages/engine/src/state.ts:168–175`; `LpBar` animates them. MCP has event-to-text rendering in `packages/mcp/src/render.ts`, but its recent event buffer is not a browser log or durable history.
- **Impact:** “What resolved?”, “what did they reveal?”, and “why did LP change?” cannot be checked after animations disappear.
- **Approach:** append a bounded, scrollable turn/phase/chain log from redacted events **before** animation consumption; inspectable card links and filters. Retain hints with their audience. Derive an LP ledger (before/after, damage/recovery/cost/direct update, turn/chain); expand the protocol if direct `LPUPDATE` needs a distinct reason rather than labeling it damage. Reuse it for replays. No hidden-card inference from absent event fields.

### 1.5 Competitive time limits / chess clock — P1 / M

- **EDOPro:** host-configured time limit with visible remaining time. **E/** `duelclient.cpp:233`, `drawing.cpp:577`, `generic_duel.cpp` time accounting and `MSG_NEW_TURN` reset. Not equivalent to a universal chess clock.
- **ygosim:** real **per-decision** timeout, default 180 seconds, configured at server level; `packages/server/src/room.ts` (`waitFor`, `resolvePrompt`) auto-picks a legal default on human timeout. No remaining-time wire message/display or room-selected limit. This is an LLM-friendly safety deadline, not a competitive turn budget: successive prompts reset it.
- **Impact:** unbounded thinking across many prompts, surprising auto-actions, and no meaningful human competitive pacing.
- **Approach:** server-authoritative monotonic turn/player budgets, deadline/time-sync messages, visible countdown, documented reset/increment and timeout-loss rules. Offer casual/agent/competitive presets; don't silently use tournament rules for agent practice. Define whether animation lag, reconnect grace, and siding consume clocks. A whole-game chess clock can be an optional separate policy. Keep expiry atomic with action submission.

### 1.6 Side decking and matches — existing; polish/verification gap, P1 / M

- **EDOPro:** server best-of settings, side-deck stage, first-player choices; **E/** `generic_duel.cpp`, `network.h` (`best_of`, siding protocol).
- **ygosim:** **implemented**, not absent: `DuelSetup.tsx` Single/Best of 3; `apps/web/src/duel/SideDeck.tsx`; `packages/server/src/room.ts` (`submitSideDeck`, `sideDecks`, `run`, `finish`) conserves registered cards/section sizes, tracks scores, permits previous loser's first-player choice. Bots restore the original deck instead of strategic siding. Siding automatically finishes after 60 seconds without a visible countdown.
- **Impact/gaps:** complete browser multiplayer match is not end-to-end certified in `docs/PRODUCTION-READINESS-PLAN.md`; draw treatment and game counts need explicit policy. `finish` ends after `game >= 3` even without two wins, so draws can leave no normal two-win match outcome. `DuelScreen.tsx` displays `game + 1` although server `game` starts at 1/increments, suggesting off-by-one UI numbering. First game always starts player 0 in `Room.run` (no initial RPS/choice flow).
- **Approach:** fix/count games consistently; define draw/tie/match-win/surrender policy, add first-game coin/RPS decision, show both Ready states and siding deadline, use the latest accepted sided deck in subsequent UI, and run two-browser full-match tests including rejection/retry, draws, timeout, and disconnect during siding. Add strategic bot siding only with deck executors. Configurable best-of is a further P2/S–M extension.

### 1.7 Surrender, draw offers, and rematch — P2 / S–M

- **EDOPro:** surrender and negotiated rematch are verified (**E/** `generic_duel.cpp` `Surrender`/`RematchResult`, `network.h` `CTOS_REMATCH_RESPONSE`/`STOC_REMATCH`). No negotiated draw-offer message was found in this upstream protocol: a core-produced draw is not a draw offer.
- **ygosim:** surrender **implemented** in `DuelScreen.tsx`, `Room.surrender`, MCP `surrender` tool. Core draws (`winner: null`) supported. Result UI only offers Return; no rematch or draw-offer messages in `packages/protocol/src/index.ts`. During Bo3, surrender concedes the current game, not explicitly the entire match.
- **Impact:** friends must create/rejoin another room; accidental click concedes; no mutually agreed early draw or clear “concede match” action.
- **Approach:** confirmation for surrender plus explicit game/match concession distinction. Mutual rematch proposal/accept with retained seats and validated deck/rule selections; new game seed, clean timers/traces/agent states. Draw proposal/accept/reject is an optional service extension with expiry and competitive policy. Cover simultaneous accept/surrender/disconnect races.

### 1.8 Piles and pile viewer — existing; polish gap, P2 / S–M

- **EDOPro:** card-list/pile browsing, inspection, overlay lists and selection panels: **E/** `client_field.cpp`, `event_handler.cpp`, `duelclient.cpp`.
- **ygosim:** **implemented**: `DuelScreen.tsx`'s `pile` state/modal filters current cards by controller/location and sorts sequence; `apps/web/src/duel3d/Scene3D.tsx` has clickable piles. Visible cards are inspectable/selectable; hidden cards remain backs. Xyz overlays exist in `CardRef.overlays`, but `Inspector.tsx` only accepts a passcode/static card data and does not expose an attached-material list.
- **Impact/gaps:** basic visibility already works; lacks searchable/filterable pile management, a dedicated attached-material inspector, and richer contextual labels/quick navigation. The viewer is driven by the already-redacted state, so it must not be “fixed” by fetching unrestricted deck contents.
- **Approach:** friendly location names, owner/count badges, search/sort public piles and own Extra Deck, material-view navigation, keyboard/mobile accessibility, and selection status across pile/main board. Preserve sequence when order matters and do not expose hidden deck order.

### 1.9 Host custom rules/options and Speed Duel — P2 / M–L

- **EDOPro:** custom starting LP/hand/draw, MR/duel flag presets, no-check content/size, no-shuffle, deck-size bounds, Speed/Rush, team/best-of options. **E/** `duelclient.cpp:230–247`, `menu_handler.cpp`, `network.h` host settings, `generic_duel.cpp` application of options.
- **ygosim:** `DuelSetup.tsx` exposes only format/match and bot/agent selections. Engine `DuelOptions` supports LP/MR, but room creation does not expose them; `createDuel` replaces them with fixed format settings. `packages/engine/src/formats.ts` presets determine hand/draw/limits. Validation always runs; main deck is always initially seeded-shuffled in `packages/engine/src/index.ts`. “Unlimited” removes the banlist, **not** deck validation. Speed preset (4000 LP/four cards/20–30 main) and `MODE_SPEED` **exist**, but skill-card UX/layout and full Speed behavior are not certified. Three-column field needs a corresponding layout rather than assuming standard five-zone geometry (`duel3d/space.ts`, `duel/layout.ts`).
- **Impact:** casual house rules/testing and custom challenge rooms unavailable; a Speed label can overpromise if field/skill presentation remains standard.
- **Approach:** validated host-options schema propagated protocol → room → engine; immutable publicly visible room rule summary. Separate no-content-check/no-size-check from “no banlist”; still reject unknown IDs/unsafe inputs. Separate initial shuffle suppression from core pseudo-shuffle semantics (EDOPro no-shuffle also affects core shuffling). Format-aware layout/phase/skill controls and dedicated Speed tests. Whitelist supported flags rather than accept arbitrary BigInt flags over JSON.

### 1.10 Historical formats and arbitrary banlist dates — P2 / M

- **EDOPro:** selectable LFLists plus custom rule modes/scripts; **E/** `deck_manager.cpp`, `menu_handler.cpp`, `repo_manager.cpp`. Correct historical behavior still depends on appropriate rules and scripts, not just a date label.
- **ygosim:** GOAT/Edison presets exist, MR1 and whitelists; `formats.ts` reduces loaded lists to the newest per recognized category (skips Rush/world categories). `makeScriptReader` in `packages/engine/src/data.ts` tries `official` before `pre-errata`/`goat` for all formats. `docs/RULING-COVERAGE.md` explicitly records modern Sangan behavior risk, Edison whitelist absence in reviewed data, and GOAT 15/60 size mismatch. This is **configuration support, not faithful historical rulings**.
- **Impact:** historical players cannot choose arbitrary banlist dates and may receive modern effects under historical branding.
- **Approach:** stable banlist IDs/date enumeration (separate from rules preset), format-selected script reader with card-level errata overrides, faithful deck bounds, and sourced GOAT/Edison regression fixtures. Document unavailable/incomplete modes until qualified. Do not globally prefer every pre-errata script in modern play.

### 1.11 Puzzles / scripted duels / solo practice — P2 / L (curated fixture MVP: M)

- **EDOPro:** Lua single-mode puzzles, restart, hand-test mode; **E/** `single_mode.cpp` and `deck_con.cpp` hand-test options; **D/** `config/configs.json` auto-updates ProjectIgnis/Puzzles.
- **ygosim:** `apps/web/src/mock.ts` is an explicitly labeled scripted demo, **not real Lua puzzle support**. Production `createDuel` builds two ordinary decks; no puzzle source/setup/goal protocol or single-mode loader. Controlled test harness `packages/engine/test/helpers/controlled-duel.ts` provides useful board-fixture precedent, not a player-facing mode.
- **Impact:** no reproducible combo scenarios, challenges, tutorials, or training boards against the real core.
- **Approach:** safe curated scenario registry, server-side setup plus win condition/hints/restart; add required single-mode core/decoder support (inspect `RELOAD_FIELD` and puzzle messages). Separate trusted operator-provided Lua puzzles from user uploads: arbitrary scripts in synchronous server WASM are an availability hazard. Run scenarios in terminable workers with resource quotas. Agents could solve the same scenarios via MCP.

### 1.12 Rush Duel — P3 / L

- **EDOPro:** explicit Rush preset/flags, three-column field/no Main2/no Standby/draw-until-five/unlimited summons and Rush card/scripts. **E/** `ocgapi_constants.h:417`, `menu_handler.cpp`, `deck_con.cpp`.
- **ygosim:** no Rush format or `MODE_RUSH` application in `packages/engine/src/index.ts`. `data.ts:cdbFiles` explicitly excludes `prerelease-cards-rush*`; generic `release-*` loading alone cannot establish Rush coverage. Script reader does search a `rush` directory, but that is **not Rush support**. Protocol phase model/layout/search types/race mapping also need Rush-specific review (Maximum/Legend/fusion/new races).
- **Impact:** Rush players cannot use this simulator reliably; importing a Rush-looking card doesn't enable Rush rules.
- **Approach:** dedicated Rush data domain and legality (including Legend limits), proper flags, three-column layout/phase UI, Maximum mechanics/prompts/replays/AI compatibility, and Rush card text/type decoding. Qualify against representative real Rush decks and independent rule assertions. Avoid assuming the currently pinned wrapper/core matches all latest upstream Rush flags.

### 1.13 Tag duels (2v2) / relay — P3 / L

- **EDOPro:** generic teams (embedded server clamps 1–3 per side), tag and relay host options and replays: **E/** `netserver.cpp:361–363`, `generic_duel.cpp`, `replay_mode.cpp`, `network.h`.
- **ygosim:** two seats/decks in `Room`, `PlayerIdx = 0 | 1`, fixed two-player LP/state, core cards created with `duelist: 0` in `packages/engine/src/index.ts`. No team/active-partner/deck-switch events or four-player UX.
- **Impact:** cannot play social 2v2, and this is architectural rather than a checkbox omission.
- **Approach:** distinguish participant/seat/team/active-duelist IDs throughout protocol, privacy and engine bridge; team LP and turn rotation; hidden partner-hand policy; reconnect/surrender/siding policies per team; new layout and replay format support. Implement 2v2 first, relay later, rather than widen `PlayerIdx` without core semantics.

## 2. Deck editor and interoperability

### 2.1 Advanced card search — P1 / M

- **EDOPro:** name/text/archetype search; card/subtype, attribute/race, level/rank/link, ATK/DEF comparative values, scales, link markers, effect-category and legality filters. Evidence: **E/** `deck_con.cpp` `StartFilter`/`FilterCards`/`CheckCard`, notably `parse_filter`, setcode handling and link marker mask.
- **ygosim:** `DeckEditor.tsx:CardBrowser` offers name-or-text, broad Monster/Spell/Trap/Extra, attribute/race, exact level and name/ATK/level sorting. `packages/server/src/server.ts` `/api/cards` searches **both name and desc** and applies exact attribute/race/level. `carddb.ts` stores raw setcode and link/scale data, but public `CardData` lacks archetype/setcode and only exposes one scale. Exact `level` doubles as rank/link-rating; no explicit differentiated range UI. HTTP `kind` delegates to `db.search({type: kind})`; the editor's **Extra** token does not match any `CardData.type` string, suggesting an empty-results bug (Fusion/Synchro/Xyz/Link are the actual types). Name search alone in `SqlCardDb.search` is not the full HTTP browse behavior.
- **Missing fields:** archetype/setcode; detailed monster/spell/trap subtype combinations; level/rank/link comparisons/ranges; ATK and DEF ranges/unknown values; left/right scale range; link-marker mask; dedicated text/name modes, legality/card-pool filtering and effect categories. Attribute/race/effect text are already present and should be expanded, not rebuilt.
- **Impact:** building unfamiliar archetypes and finding exact tech/material requirements is far slower than EDOPro.
- **Approach:** one typed browse-query schema shared across web/API; implement from raw numeric flags/setcodes using `loadStrings().setname`. Fix Extra as a union predicate. Expose both scales, explicit stats/unknown values and legality domain; add indexed/precomputed matching for large pools. Advanced collapsible filters, useful presets and keyboard navigation. Tests should independently cover **every requested field** and combinations, including aliases, setcode subtype bits, Link DEF-as-marker storage, and rank-versus-level semantics.

### 2.2 Banlist switching — present; arbitrary/custom lists gap, P2 / M

- **EDOPro:** selectable banlist entries/dates and limit/card-pool filters; **E/** `deck_manager.cpp`, `deck_con.cpp`.
- **ygosim:** **implemented current-format switching** in `DeckEditor.tsx`, `useBanlist`/`useFormats` in `apps/web/src/ui/kit.tsx`; live validation, limit badges and add caps. `/api/formats` and `/api/banlist/:format` server endpoints backed by `formats.ts`. No arbitrary date/custom/world/Rush list selection; latest-category cache only. Client `limitOf` counts exact codes, whereas server validation canonicalizes aliases; UI caps/whitelist behavior can disagree with authoritative alias handling.
- **Impact:** cannot reproduce older tournaments or custom events; alias copies may look legal until server rejection.
- **Approach:** independent banlist catalog with stable IDs, metadata/date/card-pool domains and server canonical legality helper exposed to editor. Include format provenance in exported/shared decks, while keeping YDK/ydke compatible. Server remains authoritative.

### 2.3 Deck statistics and hand testing — P2 / S for stats; M–L for real solo test

- **EDOPro:** deck counts/summary presentation and **real core hand-test mode** with custom hand size, MR/Speed/Rush and no-shuffle settings: **E/** `deck_con.cpp:174–206`, `single_mode.cpp`. Detailed statistical/probability dashboards are an enhancement, not established EDOPro parity here.
- **ygosim:** main/extra/side counts and copy counts in `DeckEditor.tsx`/`Home.tsx`; no type/level/attribute charts, opening draw/mulligan simulator, probability tools, or genuine no-opponent hand-test screen.
- **Impact:** users must start a full bot duel to practice openers; poor feedback about ratios and consistency.
- **Approach:** local analytics plus sample opening hand/reset/draw with declared format hand size; seeded runs and probability calculations can be educational. Distinguish **random sample-hand preview** from **interactive solo core practice**. For the latter add a separate core practice mode, opponent board/no-opponent option, restart and combo trace, leveraging puzzle isolation. Never treat local mulligans as normal duel actions.

### 2.4 Deck sharing/import formats — partial parity; extensions P2 / M (YDK/ydke need no rebuild)

- **EDOPro:** native YDK and clipboard ydke/card-name export/import: **E/** `deck_con.cpp:140–148`, `deck_manager.cpp`.
- **ygosim:** `apps/web/src/decks/importers.ts` parses/exports **YDK and ydke**, imports named card lists; `ImportDeck.tsx` file/drop/paste, server name resolution; `DeckEditor.tsx` Copy ydke / Export .ydk. `packages/engine/src/ydk.ts` and `packages/mcp/src/deck.ts` support agent deck inputs. This is substantial sharing support already.
- **Missing:** explicit browser deep-link loading/share URLs, YGOPRODeck deck URL/API import, Omega codes, Master Duel/official deck identifiers. No evidence that Omega/MD codes are native EDOPro capabilities; classify them as ecosystem convenience work.
- **Impact:** users can already move EDOPro decks, but copying a deck-site URL/code may fail or be misread as a named list.
- **Approach:** stable `ygosim` share links wrapping supported data; format-specific parsers with strict bounds/errors. First add documented YGOPRODeck URL/API adapter and code/passcode mapping; use allowlisted fetches, caching/rate limits and unmatched-card reporting (never unrestricted URL fetch/SSRF). Add Omega only against a documented/versioned encoding with fixtures. MD numbers are not necessarily public self-contained passcode encodings: use a supported export/official adapter or require a card-list/YDK conversion; do not promise arbitrary code decoding. Round-trip main/extra/side and illegal-deck diagnostics.

## 3. Online service

### 3.1 Lobby/room browser, passwords and room controls — partial; P2 / M

- **EDOPro:** multi-server room lists/filtering (rules, banlist, teams, best-of, relay), private/password rooms, ready/seat controls: **E/** `server_lobby.cpp`, `menu_handler.cpp`, `network.h`.
- **ygosim:** `Home.tsx:OnlineRooms` polls every three seconds, lists waiting/live rooms with format/Bo3, join-by-code/create/watch; `packages/server/src/lobby.ts` manages rooms and `/api/rooms` in `server.ts`. Not missing a browser. No password, private/unlisted flag, title/search, rules filter, deck-ready handshake or deliberate spectator permissions. Room code is discoverable in the public list and is **not authentication**. `Room.join` starts immediately once two seats are occupied.
- **Impact:** private friend/agent games are not truly private; hard to browse crowded deployments or agree rules/decks before auto-start.
- **Approach:** room metadata/filtering, private/unlisted rooms and independent hashed password/token join flow, host-ready/start/kick controls with abuse safeguards, observer access policy. Return appropriate public/private summaries, never password hashes; do not expose seats/deck data beyond intended audience. Include room policy in MCP tools.

### 3.2 Spectators and chat — present; privacy/UX validation gap, P2 / M

- **EDOPro:** live observer role, counts, chat and observer state delivery: **E/** `generic_duel.cpp`, `duelclient.cpp`, `network.h`.
- **ygosim:** explicit `spectate` wire message, full-room joining as observer, browser Watch, room chat; `Room.spectators`/`Room.chat`, `packages/server/src/spectator.ts` redacts both hands/decks/face-down cards and private hints; real-engine privacy tests documented. `DuelScreen.tsx` still presents player-oriented “Your/Opponent”, thinking and Surrender controls even for observers because state uses a player-index viewpoint. Public reveal handling merits review: `spectator.ts` re-hides cards by location and starts from player-0 redaction, so it cannot automatically recover every public reveal to a hidden location.
- **Impact:** observers can watch today, but viewing agent games does not let spectators see pilot hands, labels are misleading, and reveal policy may omit legitimately public information. Chat lacks moderation/mute controls.
- **Approach:** explicit observer mode and orientation, hide player-only actions/prompts, spectator count and chat mute/moderation. Define public-only versus opt-in practice/coach viewing (never grant unrestricted hand visibility by default), optional broadcast delay. Test late join, reveal audiences, face-down banish, chain activation, overlays, control change, chat and reconnect with two browsers + observer. Docs explicitly say complete browser observer flows remain unverified.

### 3.3 Reconnect after disconnect / restart durability — P1 / L (same-process resume: M)

- **EDOPro baseline:** no general embedded-server resume was found; **E/** `generic_duel.cpp:245–307` ends active games when a seated player leaves, and protocol lacks a resume handshake. External hosts may add policies; don't claim them universally. Reliable resume is a **Master Duel-style/service expectation** and a major ygosim opportunity.
- **ygosim:** deliberately unsupported: `docs/DEPLOYMENT.md` says anonymous process-local rooms, no reconnect tokens/restored games; `Room.leave` concedes an active duel. `apps/web/src/net.ts` / `useDuel.ts` surface terminal close/recovery, not automatic resume. Restart destroys all games.
- **Impact:** a Wi-Fi blip/tab refresh ends the game and can spoil a match; unacceptable foundation for ranking or longer agent games.
- **Approach:** first separate logical session/seat from socket; random secure resume token, bounded grace period, snapshot + event sequence cursor + current prompt on reattach, duplicate/stale action protection. Handle disconnect during **siding**, not only active games. Document timer policy. Same-process resumability does not imply restart durability. Later checkpoint deterministic inputs/responses with versioned data, worker isolation and durable room ownership; accounts/multi-instance routing need separate design. No seed/private trace in browser resume tokens.

### 3.4 Server-side saved replays / replay archive — P1 / M after recording schema

- **EDOPro:** embedded server records full replays and transmits replay payloads (**E/** `generic_duel.cpp` `last_replay`/`new_replay`, **E/** `network.h` replay messages). A searchable durable public archive is host/service dependent, not guaranteed by desktop client.
- **ygosim:** no replay storage/API/object store; rooms/diagnostics are in-memory and cleaned up (`lobby.ts`, `room.ts`, deployment docs). Native-differential artifacts are tests, not a player's server replay archive.
- **Impact:** if clients disconnect, useful history is lost; no links for tournaments/support or agent-duel sharing.
- **Approach:** record authoritative stream server-side, finish/abort metadata, retention quotas and consent/access control. Store game-per-match manifests in object storage/SQLite for a small single-instance deployment, expose scoped download/list APIs and expiry. Retain crashed/incomplete recordings as explicitly incomplete. Split public redacted artifacts from restricted omniscient reproduction records. Add replay availability to result UI and MCP.

### 3.5 Ranked matchmaking/accounts — P3 / L; not verified EDOPro desktop parity

- **EDOPro:** configured Casual/Competitive server endpoints in **D/** `config/configs.json`; that alone does **not** demonstrate a desktop-native rank ladder, Elo accounts, or authoritative ranked matchmaking. Such services can exist externally. Master Duel provides an account-backed ladder.
- **ygosim:** anonymous names/self-declared agent kind; no account auth, queue, ratings, anti-smurfing, match history or ranked mode (`protocol/src/index.ts`, `server.ts`, `lobby.ts`, `docs/DEPLOYMENT.md`).
- **Impact:** no progression or reliable opponent matching, but premature ranking would amplify disconnect/timer/identity problems.
- **Approach:** only after recovery, clocks, replays and operational validation: authenticated sessions, ranked rule/banlist snapshots, queues, durable outcomes/Elo, anti-abuse and disconnect adjudication. Separate humans, built-in bots and agent leagues; self-declared client `kind` is not proof of identity. Competitive EDOPro server labels are not a substitute for this infrastructure.

## 4. AI practice quality

### 4.1 WindBot archetype executors versus generic bots — P1 / L (first curated executor: M)

- **WindBot:** shared `Executor`/`DefaultExecutor` and many deck-specific policies under **W/** `ExecutorBase/Game/AI/` and `Game/AI/Decks/`: Blue-Eyes, Swordsoul, Branded/Albaz, Labrynth, Ryzeal, Maliss, etc. Example `SwordsoulExecutor.cs` registers card-specific activation/summon priorities, selects materials/targets, tracks decisions and sequencing. Archetype coverage/banlist currency varies; these are not universal perfect AI.
- **ygosim:** `packages/server/src/ai/easy.ts` random/simple behavior; `normal.ts` scores labels/actions/stats and shared legal candidates; `hard.ts` extends Normal with approximate one-ply **battle** evaluation and lethal detection, not engine search/combo planning. No deck-executor registry or card-effect-specific strategy. `Room.sideDecks` resets bots to registered decks. The maintained bot matrix in readiness docs establishes completion/selection reliability for sample decks, **not strategic strength**.
- **Impact:** modern combo and interruption practice can be misleading; a bot that legally completes every game can still waste searches/negates/materials and pilot an archetype poorly.
- **Approach:** introduce executor hooks by known deck/profile/card/effect IDs for action ranking, targets/material selection, per-duel memory, and siding. Keep legality/progress budgets centralized, generic fallback for unsupported decks, and a curated “supported bot decks” selector with versioned decklists. First implement two contrasting decks with asserted opening lines and interruption decisions; measure win rate and combo success, not only natural completion.
- **Alternative:** adapt WindBot as a sidecar, but it uses the YGOPro network model, not this prompt-enumeration WebSocket protocol. Either provide a faithful native-protocol gateway or adapt its executor APIs with enough structured effect/chain/card state; simply launching WindBot beside Node is insufficient. Review upstream licenses when reusing code. LLM/MCP opponents are a distinct complementary capability, not a low-latency replacement for every archetype bot.

## 5. Data, images, and updates

### 5.1 Automatic, consistent card/script/banlist updates — P1 / M

- **EDOPro:** repo manager/updater and configured auto-updating repositories: **E/** `repo_manager.cpp`, `repo_cloner.cpp`, `client_updater.cpp`; **D/** `config/configs.json` has `should_update` repositories (DeltaBagooska packaged core/data/scripts, LFLists, Puzzles). The current Distribution config should not be inaccurately described as three direct runtime clones of BabelCDB/CardScripts/LFLists.
- **ygosim:** `scripts/fetch-data.sh` manually fetches CardScripts at pinned `242ce154c2c8dad08e24fa2330b96b6d25420b07` (override available), updates BabelCDB/LFLists to latest, and separately downloads current strings. `carddb.ts`/`formats.ts`/`data.ts` cache loaded data; successful loads do not hot-refresh. `docs/DEPLOYMENT.md` requires operator fetch/release validation. This is a real fetch pipeline, **not automatic coherent release promotion**.
- **Impact:** new cards can arrive in DB before compatible pinned scripts/core; banlist and strings can drift; same format label changes across deployments and makes replays unreproducible.
- **Approach:** scheduled CI update candidate with explicit core/scripts/CDB/LFLists/strings hashes, schema/API checks, missing-script audit, representative card/format/bot/browser/native gates. Publish immutable data bundles atomically; roll back on failure and keep old bundles for replay reproduction. Promote validated snapshots, never `git pull` live between games. Show data-version/new-card status and bind each room to a snapshot. Security/resource checks matter as scripts execute on shared synchronous WASM.

### 5.2 Card images / prerelease art coverage — P2 / M

- **EDOPro:** configurable picture/field/cover downloader and cache: **E/** `image_downloader.cpp`, `image_manager.cpp`; **D/** `config/configs.json` URLs. External resources/rights still apply.
- **ygosim:** `packages/server/src/image-cache.ts` implements bounded runtime YGOPRODeck CDN caching/proxy, full/small variants, retry/queue/shutdown controls; `apps/web/src/duel3d/textures.ts` loads visible textures. `docs/DEPLOYMENT.md` accurately says CDN outage leaves placeholders and deployment isn't offline-art capable. Core supports cards whose art source may not have an image yet.
- **Impact:** prerelease/alternate cards or CDN failures can create blank boards; art request logs can leak private card identities.
- **Approach:** provider abstraction with permitted sources, immutable manifest/checksums/version metadata, negative cache + retry/backoff, preload commonly used **public deck-library** art, explicit missing-art/name placeholder. Optional licensed/offline cache packs, operator-controlled fallback, no arbitrary fetch URLs; preserve visible-only requests and private access logs. Don't redistribute copyrighted images just because the simulator is open source.

### 5.3 Prerelease cards / legality/card-pool labeling — partial, P2 / M

- **EDOPro:** release/prerelease data and card-scope filters; loaded extensions/data depend on distribution. **E/** `data_manager.cpp`, `deck_con.cpp` limitation/OT filters, repo manager.
- **ygosim:** `data.ts:cdbFiles` loads `cards.cdb`, `release-*`, and non-Rush `prerelease-*`; script reader searches `pre-release`. **Prerelease support already exists for regular cards.** `RawCard.ot` is retained in `carddb.ts`, but public `CardData` and `formats.ts:validateDeck` do not enforce TCG-versus-OCG/prerelease availability using it; banlist legality alone doesn't exclude unreleased/regional cards.
- **Impact:** a deck marked “Legal in TCG” may include OCG-only or prerelease cards; deck search gives no clear pool/release status.
- **Approach:** add card-domain/release metadata from the source's actual bit definitions, pool filters/badges and format legality enforcement, opt-in prerelease casual rooms and explicit advertised status. Validate current banlist and allowed pool independently; preserve old metadata snapshots for replays. Avoid simplistic `ot == 1` assumptions because flags can combine.

### 5.4 Alternate arts — partial data, missing discovery/selection; P3 / M

- **EDOPro:** alias/alternate-image-aware data and deck handling: **E/** `data_manager.cpp`, `deck_manager.cpp`, picture manager. Available variants depend on installed databases/images, not every commercial print variant.
- **ygosim:** raw aliases and alias-aware server copy limits exist (`carddb.ts`, `formats.ts`). `SqlCardDb.search` **suppresses nearby aliased passcodes as alt arts**; no art-variant selector. An imported alternate passcode may still load, but that is not a discoverable feature, and CDN coverage is not assured.
- **Impact:** users cannot easily select favorite artwork; editor copy-cap indicators can disagree across variants.
- **Approach:** canonical card identity plus selectable supported art variants with availability metadata; keep rules/text/limits canonical, preserve chosen art where compatible with YDK, offer original-image fallback. Fix alias counting in editor and tests; do not confuse pre-errata cards with cosmetic art aliases.

## 6. What ygosim does better / distinctive advantages

1. **First-class coding-agent play.** `packages/mcp/src/tools.ts`, `client.ts`, `render.ts`, `cli.ts`, `docs/AGENTS.md`: MCP plus persistent JSON-lines CLI; enumerated legal prompts, stale-prompt IDs, named board/event summaries, human-vs-agent and agent-vs-agent viewing. Claude Code/Codex are supported without inventing a desktop UI automation layer. Local process launch is deliberately restricted and not the same as public authenticated agent hosting.
2. **Zero-install browser delivery and modern presentation.** React/three.js (`apps/web/src/duel3d/{Scene3D,Card3D,Fx3D}.tsx`) with camera, animations and effects brings a more Master Duel-like aesthetic than EDOPro's traditional desktop interface, plus browser/mobile reach. This is a presentation/distribution advantage, not proof of better latency or mobile accessibility; MD itself has a richer commercial presentation.
3. **One explicit human/bot/agent decision contract.** `packages/protocol/src/index.ts` shared prompt constraints, selection validation and legal candidate generation; browser, server bots, fallback and MCP consume it. This creates unusually accessible agent integration and cross-client regression surfaces. Continue exposing structured timing/effect metadata instead of making consumers parse English labels.
4. **Reproducible native/WASM differential testing.** `packages/engine/test/native-reference.test.ts`, `packages/engine/scripts/reference/build-native-reference.sh`, `docs/EDOPRO-COMPARISON.md` and readiness update: lockstep raw messages/responses/queries against pinned unmodified native core, with provenance. A strong project-specific quality asset for a WASM bridge; this does not establish that EDOPro lacks tests or prove shared-core rulings independently.
5. **Explicit privacy and honest operational boundaries.** `spectator.ts`, engine redaction, shared constraint tests, keyed operator diagnostics, protected agent-launch endpoints, deployment/recovery docs and maintained bot matrix. These are valuable foundations. Do not equate them with ranked-service readiness or certification of all UI modes.

### Avoid stale-audit false positives

`docs/RULES-AUDIT.md` and `docs/EDOPRO-COMPARISON.md` describe historical tribute/bot/Ritual-label failures. The later `docs/PRODUCTION-READINESS-PLAN.md` says those fixes landed; current shared weighted constraints and bot candidate generation confirm the changed implementation. They should **not** be reported as current missing features. Conversely, documented passing core/native tests do **not** certify full browser multiplayer, observer, Bo3, Speed, historical, or Rush flows. Run those gates when implementing the roadmap.

## 7. Top-10 prioritized roadmap

Ordered for player value and dependencies, not maximum checkbox count. Keep unsupported historical/Speed claims visibly qualified immediately; Rush/tag/ranked remain later expansions.

| Rank | Deliverable | Effort | Exit criterion |
|---|---|---|---|
| **1** | **Reliable reveal/confirm tray + retained duel log/LP ledger** | **M** | Public/private search/reveal, hints, chain resolution and LP costs are inspectable after animation; no observer/private replay leak. |
| **2** | **Full chain policy controls** (Auto/On/Off + temporary override, explicit mandatory/order metadata) | **M** | Empty windows, optional/mandatory triggers, SEGOC and Damage Step browser tests; no policy skips mandatory effects. |
| **3** | **Advanced deck search + accurate legality** | **M** | Every requested field works, Extra filter fixed, aliases canonicalized, TCG/OCG/prerelease pools and banlist IDs distinguishable. |
| **4** | **Saved browser replays + authoritative server recording** | **L** | Finish/abort replay available by scoped link/download; pause/step/seek and correct redacted playback after shuffle/reveal/control changes; immutable provenance. |
| **5** | **Same-process disconnect resume** | **M** (durable restart later **L**) | Refresh/network loss reattaches the correct seat/current prompt without duplicate action, including siding; documented grace/timer/privacy policy. |
| **6** | **Visible configurable clocks + match flow hardening + mutual rematch** | **M–L** | Two-browser complete Bo3 with first-game start choice, accurate game counts, draw policy, siding countdown/retry, competitive timeout and rematch. |
| **7** | **Versioned automatic data-update promotion** | **M** | Scheduled candidate audit/tests → immutable core/scripts/CDB/list/strings bundle; room/replay snapshot binding and rollback; no mixed live revisions. |
| **8** | **Curated archetype-aware practice bots** | **L** (first executor **M**) | At least two supported decks execute asserted combo/negate/material decisions and report strategic metrics as well as completion. |
| **9** | **Solo hand-test/statistics + curated puzzle mode** | **L** (stats/sample hands **S**) | Real-core resettable practice and trusted challenges; clearly distinct sample-hand preview; agent puzzle play works under resource limits. |
| **10** | **Host/lobby flexibility** (private/password rooms, ready handshake, bounded custom LP/hand/draw/MR/no-check/no-shuffle, qualified Speed UX) | **M–L** | Rules visible before joining; private access enforced; options applied end-to-end; format-aware board/skills and targeted tests. Then consider Rush/tag before an account-backed ranked league. |
