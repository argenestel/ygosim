# Real-browser release smoke tests

From the repository root:

```sh
pnpm install --frozen-lockfile
bash scripts/fetch-data.sh
pnpm exec playwright install chromium
# Linux CI/minimal hosts need system browser libraries:
# pnpm exec playwright install --with-deps chromium
pnpm test:e2e:typecheck
pnpm test:e2e
pnpm exec playwright show-report
```

The suite requires the real WASM core, database, and pinned ProjectIgnis scripts. It never uses `?mock=1`, intercepts gameplay responses, or calls the development hook's submit function. Each test launches its own real server and Vite process, both binding port 0, with explicit HTTP/WebSocket proxy targets and HMR disabled. Test Vite ignores project dotenv files and overrides the frontend WebSocket URL so a personal development setting cannot redirect gameplay to another server. Agent launching is disabled in isolated test servers. Graceful teardown closes rooms, engine handles and sockets; the launcher kills a child after a five-second shutdown deadline. Playwright supplies a new context and empty storage for every test. One worker avoids contention with synchronous WASM and software WebGL.

Natural duels use seed 42 and the four repository sample decks against Normal. Decks are selected through the UI. The player driver uses the production NormalBot's bounded legal candidate generation and scoring to choose decisions, then clicks every decision with auto-pass disabled. It never invokes the bot to dispatch a response. A natural loss counts as a complete duel; neither surrender nor timeout/abort nor a decision cap counts. These smoke games do **not** promise that the player's strategy executes every advertised procedure; separate controlled browser fixtures assert Fusion/Synchro/Xyz/Link/Ritual/Pendulum summons and their authoritative events.

Natural games use a development-only test define that disables shadows and postprocessing to avoid saturating software WebGL. Geometry, camera, layout, animations, and pointer handlers stay unchanged. Controlled summon/tribute/mobile fixtures retain normal graphics. This suite is a gameplay usability check, not a performance certification of production graphics.

The tribute test uses the existing real-core `controlled-duel.ts` fixture to place Blue-Eyes in hand and two ordinary monsters on the field. This is a controlled opening, not a shuffled legal-deck duel. It clicks the rendered hand card and action menu, verifies that zero/one tribute cannot be confirmed, selects both field monsters through pointer clicks, clicks Confirm, and completes the summon. The only added web hook is development-only, read-only projection of target coordinates from the live camera. State/prompt hooks are observed, never used to dispatch actions. Zone selections also use pointer clicks on the rendered field.

Lifecycle tests surrender, return, start a second duel without a reload, and intentionally stop the isolated server to check the terminal disconnect screen and Return action. Returning after disconnect does not promise reconnect/resume support or a successful restart while the server is down.

The SideDeck component fixture renders the production component with real sample-deck/card data, checks bounded desktop/mobile card geometry, loaded art and accessible selection toggling, supplies a synthetic rejection through its error prop, and clicks Ready twice to verify error visibility and retry behavior. It is a component-render check, not a real Best-of-3 room or a browser proof of server pool-validation rules; those boundaries remain covered separately by server tests.

## Evidence and failures

`test-results/` contains per-test screenshots, server/frontend logs, and attachments. Failed tests retain Playwright DOM/action/source traces, failure screenshots, browser console output, and client-visible server messages. Continuous trace screencasts and video are intentionally disabled to reduce software WebGL readback overhead; failure and result PNGs remain captured. The harness fails on unexpected JavaScript errors, server error messages, non-art HTTP failures, rejected/aborted room diagnostics, stale decisions, and bounded lack of progress using the production BotProgress guard with observed attack/chain-resolution events. Card-image failures and a missing favicon are recorded but excluded from failure assertions: external art availability is not a rules assertion. It does not replace artwork with fake images.

```sh
pnpm exec playwright show-trace test-results/<failed-test>/trace.zip
bash scripts/test-provenance.sh artifacts/provenance.json
pnpm test:release
pnpm test:extended
```

Provenance records core/WASM, scripts/database/banlist revisions, database and deck hashes, lockfile, browser version/build, seed, and whether local source is dirty. The data fetch pins CardScripts but refreshes databases and banlists; hashes/revisions are necessary to distinguish runs. These artifacts contain synthetic test gameplay, not environment dumps. Do not publish logs from unrelated sessions or private agent runs.

`Release checks` runs data fetch, package tests, opt-in real-engine server integration tests, engine lint, server/MCP typechecks, frontend build, E2E typecheck, and browser tests on pushes/PRs. Scheduled/manual runs additionally build the pinned native reference, run differential assertions, audit script initialization, and fuzz 20 deterministic random duels at seed 20261002 with a 4,000-decision budget. The initial 500-decision run had 16 inconclusive caps; the explicit 4,000-decision rerun completed 20/20 naturally, so the scheduled gate uses that verified budget. Neither run implies a core defect or exhaustive correctness. The extended gate checks reports and fails for missing/erroring scripts or any inconclusive fuzz outcome; an exit-zero report writer alone is not a passing release gate. Reports are archived even on failure. Native comparison shares upstream rules and is not an independent ruling oracle.

## Deliberate coverage gaps

This is Chromium smoke coverage, not completion of plan sections 5/8. Remaining browser cases include exhaustive mandatory/weighted/interactive material details; dedicated chain targets/costs and attack replay; full mobile/touch and keyboard gameplay beyond the maintained menu/rotation smoke; multiplayer creation/join, spectator privacy, agent play, Best-of-3/side-deck, and in-flight abort recovery. Alternate summon procedures with identical base labels are numbered in the menu; the driver clicks the real button identified by its action ID, but numbering does not explain a procedure's materials or rules to a person. Natural sample games exercise only the decisions that occur at the recorded seed. Unit/real-core tests cover additional rules but do not prove their browser usability. The seven opt-in server integration tests are enabled by `test:integration`; any remaining skipped/expected-failure tests remain separate release dispositions. This suite does not delete them or count them as supported features.
