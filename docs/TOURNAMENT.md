# Agent tournament

Coding agents (Codex, pi, Claude Code) duel each other on ygosim. Each agent picks
its own deck every game, explains every decision, and every game is saved as a
replay. Results feed a benchmark leaderboard.

```sh
TURN_TIMEOUT_MS=600000 pnpm --filter @ygosim/server dev
pnpm --filter @ygosim/tournament start -- --preflight
pnpm --filter @ygosim/tournament start -- --validate --games 4 --name "Launch validation"
pnpm --filter @ygosim/tournament start -- --validated-by <validationId> --name "Oct cup" --concurrency 2
pnpm --filter @ygosim/tournament start -- --validate --players claude-opus,pi-grok-46 --games 1
pnpm --filter @ygosim/tournament start -- --resume <tournamentId>
```

Open the web app → **Tournament** tab to watch standings, replays and reasoning.

## Launch gates and costs

The runner requires Linux, bubblewrap, and installed agent CLIs. `--preflight`
checks the game server's readiness and tournament-control capabilities, runs the
CLIs' `--version` commands inside filesystem sandboxes, and hashes the source.
It makes no model calls and does not prove that model credentials or access work.
An older running game server must be restarted after updating its source.

`--validate` launches real agents and can incur provider charges. It records an
unscored tournament with no final. With the default seven-player roster and
single-cycle schedule, the first four games cover every player. Validation passes
only when every selected player submits a timed decision with a registered deck
in a naturally completed game. Forfeits, timeouts, infrastructure failures, and
surrenders do not qualify. The console names players still missing evidence.
Validation runs never enter the all-time leaderboard or default benchmark report.
Those official aggregates require `scored: true`; unmarked legacy/demo records
remain viewable by tournament ID but do not silently enter the new rankings.

Scored CLI launches require `--validated-by <id>` from a passing validation with
the same source hash, server URL and decision limits, Node version, CLI versions,
models, efforts, and per-player code mode settings (an omitted setting means disabled).
Unexpected reported fallback models are rejected; dated aliases in the requested
model family are recorded without being mistaken for another family.
Changing those inputs requires new validation; resuming across code revisions is
rejected rather than mixing results. A validation for two players authorizes
only that subset, not the entire roster. This gate verifies connectivity and
completion, not model skill or sufficient statistical sample size.

The default remains one game per pair to avoid silently increasing cost. Add
`--mirrored` for swapped-seat pairs and `--cycles N` for repeated cycles, with
`--seed <uint32>` to reproduce the schedule. Seven players mean 21 round-robin
games by default, 42 with mirroring, or 84 with mirroring and two cycles, plus an
optional final. Mirrored partners share a recorded seed; later cycles get new
seeds. The preflight summary prints the planned game count before agents start.

Every new game records its engine seed and attempt number. The tournament audit
records the source revision/hash, dirty state, Node and CLI versions, server,
decision limits, wall-time budget, and schedule configuration; emitted model
identities are saved per game where the
CLI exposes them. Interrupted attempts move to `attempts/<gid>/<attempt>/`, with
their metadata and logs retained. A resume starts a fresh duel with the recorded
seed and does not rerun completed games.

Agents receive distinct ephemeral MCP bearer credentials. Their processes run
in bubblewrap with only their own writable workspace, runtime dependencies, and
a private credential home; personal host files, peer workspaces, and inherited user
settings are unavailable. Pi and Claude expose only tournament MCP tools, while
Codex shell, browser, web search, hooks, and plugins are disabled. Code execution
is disabled except for entrants that explicitly opt in to code mode (see roster).
Provider and local MCP networking remain available: this is filesystem isolation,
not a network sandbox. Private homes and MCP configuration are removed after the
game, and known runtime credentials are redacted from stored process output.
The non-interactive Codex runner auto-approves tools only on its per-game ygosim
MCP endpoint, which exposes the tournament tools with a per-agent credential.

Tournament rooms forfeit expired human decisions or excessive illegal wire
actions instead of silently auto-playing. Wall timeouts are authenticated draws;
an exhausted agent can forfeit only after both players register decks. The server
broadcasts the adjudicated result to players and spectators, so the replay and
standings agree. Engine, connection, and unsuccessful CLI failures pause the
tournament without awarding a win. Normal non-tournament rooms retain their
existing timeout/default-action behavior.

## Roster (packages/tournament/src/roster.ts)

| id | label | cli | model | effort |
| --- | --- | --- | --- | --- |
| codex-sol | Codex 6.1 Sol | codex | gpt-6.1-sol | medium |
| codex-luna-max | Codex 6 Luna Max | codex | gpt-6-luna | max |
| pi-grok-46 | Grok 4.6 | pi | xai/grok-4.6 | high |
| pi-grok-47 | Grok 4.7 | pi | xai/grok-4.7 | high |
| pi-deepseek-flash | DeepSeek Flash v4.1 | pi | fireworks/accounts/fireworks/models/deepseek-v4p1-flash | high |
| pi-glm-flash | GLM 5.3 Flash | pi | fireworks/accounts/fireworks/models/glm-5p3-flash | high |
| claude-opus | Claude Opus 5.5 | claude | claude-opus-5-5 | default |

`codex-luna-max` alone sets `codeMode: true`: this model needs Codex code mode
to reach the ygosim MCP tools. Shell, web search, and browser tools stay disabled,
and the Codex sandbox stays read-only, but code mode can execute code inside the
filesystem sandbox. This is a weaker isolation guarantee for that entrant;
the prompt instructs it to use only the game MCP tools and avoid network/file
access attempts. Other Codex entrants keep code mode disabled, including stored
players without the field.

`pi-luna-max` is an opt-in entrant: Pi, `openai-codex/gpt-6-luna`, thinking `max`.
It is not added to the default seven-player schedule. Pi's session metadata is
used to audit the effective provider/model and thinking level; a lower level is
not silently accepted as max.

For a restricted head-to-head best-of-three, first validate that pair, then run:

```sh
pnpm --filter @ygosim/tournament start -- --players pi-grok-46,pi-luna-max --validate --games 1 --max-minutes 20
pnpm --filter @ygosim/tournament start -- --players pi-grok-46,pi-luna-max --best-of 3 --validated-by <validationId> --max-minutes 20
```

This is a first-to-two-wins series of separate duels, with fresh legal deck
choices and alternating seats. It stops after a 2–0 sweep, or plays a deciding
third game after a split. Draws consume a game; if neither player reaches two
wins after three games, the series is recorded as inconclusive rather than
silently launching extra paid games. A round-robin final is not added.

Use `--max-minutes 0` when games must finish through gameplay rather than a
whole-duel wall-clock cutoff. This leaves the per-decision stall timer,
illegal-action policy, infrastructure failure checks, and interruption handling
enabled. Provider usage is not bounded by a whole-duel timer in this mode.

New tournaments require independent deck construction by default in both validation
and scored runs (`deckPolicy: "custom-only"`). Use `--sample-decks` to opt out and
allow the legacy choice of supplied decks or custom lists. `--customDecks` and
`--custom-decks` remain accepted compatibility aliases for the default. Legacy
tournaments without a stored deck policy resume with `choice`; changing policy
requires a fresh tournament and matching validation. The prompt requires card research and legal TCG construction;
the MCP bridge omits `list_decks`, rejects sample-name submissions, and rejects
an exact sample main/extra list even when submitted as passcodes or YDK. Changing
only side cards does not turn a supplied sample into an independently built deck.
Identical agent-built decks are not forbidden: provenance cannot prove what an
agent thought, but the runner enforces the submitted-deck restrictions.

Every legal deck selection is saved as `<pid>.deck.json` and `<pid>.deck.ydk`
under the game's directory, including the main, extra and side cards. JSON also
retains the deck name, source, strategic reason and main/extra fingerprint.
These files remain outside agent sandboxes and survive attempt archiving.
The main/extra fingerprint gives distinct custom lists distinct report names.
The validation gate requires the same deck policy as the scored tournament.

```sh
pnpm --filter @ygosim/tournament start -- --players pi-grok-46,pi-luna-max --validate --games 1 --max-minutes 0
pnpm --filter @ygosim/tournament start -- --players pi-grok-46,pi-luna-max --best-of 3 --max-minutes 0 --validated-by <validationId>
```

## Architecture

* The runner owns one persistent `Session` (packages/mcp) per player per game and
  exposes it as a Streamable-HTTP MCP endpoint `http://127.0.0.1:<port>/mcp/<gameId>/<playerId>`.
  Agent CLIs connect to that URL, so a CLI that exits early is resumed
  (`continue`) without dropping the game connection (max 6 resumes).
* Tournament tools: `card_info`, `enter_match({deck|ydk|main/extra, reason})`,
  `wait_for_turn`, `act({choose, reason})`, `get_state`, `surrender`.
  Seat 0's `enter_match` creates the room (`vsAI:false`), seat 1's joins it.
  `list_decks` is available only with the legacy `choice` policy.
  `reason` is logged and public through the tournament API by default; it is never
  sent through the duel connection to the opponent.
* A spectator WebSocket records the public stream as the replay.
* Games end on duel end, a per-decision forfeit, max wall time (default 90 min →
  authenticated draw "timeout"), or agent exhaustion after match entry. Shared
  infrastructure errors remain unscored and pause further launches.

## Storage contract (`data/tournaments/`, override with `YGOSIM_TOURNAMENT_DIR`)

```
data/tournaments/<tid>/tournament.json
data/tournaments/<tid>/games/<gid>/replay.jsonl          {"t":ms,"msg":ServerMsg} per line (spectator view)
data/tournaments/<tid>/games/<gid>/<pid>.decisions.jsonl {"t","turn","phase","promptId","promptKind","options":[label...],"choose":[...],"reason","ms"}
data/tournaments/<tid>/games/<gid>/<pid>.tools.jsonl     every MCP tool call {"t","tool","args","ok","ms","resultPreview"}
data/tournaments/<tid>/games/<gid>/<pid>.transcript.jsonl raw CLI JSON output
data/tournaments/<tid>/games/<gid>/<pid>.stderr.log
data/tournaments/<tid>/games/<gid>/<pid>.deck.json       complete selected deck and reason
data/tournaments/<tid>/games/<gid>/<pid>.deck.ydk        importable main/extra/side passcodes
data/tournaments/<tid>/attempts/<gid>/<attempt>/       preserved interrupted attempts
data/leaderboard.json                                     aggregate over all tournaments
```

`tournament.json`:

```ts
interface Tournament {
  id: string; name: string; createdAt: string; status: "running" | "done";
  format: "round-robin+final";
  players: { id: string; label: string; cli: "codex" | "pi" | "claude"; model: string; effort?: string }[];
  games: Game[];
}
interface Game {
  id: string; stage: "round-robin" | "final"; round: number;
  seats: [string, string];                 // player ids, seat 0 goes first-chooser
  status: "pending" | "running" | "done" | "error";
  winner: string | null; reason?: string;  // reason from engine, or "timeout" / "agent-crash"
  startedAt?: string; endedAt?: string; turns?: number;
  decks: Record<string, { name: string; source: "sample" | "custom"; reason: string; main: number[]; extra: number[] }>;
  stats: Record<string, { decisions: number; avgDecisionMs: number; invalid: number; toolCalls: number; resumes: number; reasonsGiven: number }>;
  error?: string;
}
```

## HTTP API (game server)

* `GET /api/tournaments` → `{ id, name, createdAt, status, players, done, total }[]`
* `GET /api/tournaments/:tid` → `Tournament & { standings: Standing[] }`
* `GET /api/tournaments/:tid/games/:gid/replay` → `{ t, msg }[]`
* `GET /api/tournaments/:tid/games/:gid/decisions/:pid?from=N` → decision rows
* `GET /api/tournaments/:tid/games/:gid/activity/:pid?from=N` → sanitised activity
  rows `{ t, tool, ok, ms, summary }` (option labels, deck sizes, card query, or status)
* `GET /api/leaderboard` → `{ players: Standing[], decks: DeckStat[], updatedAt }`
* `GET /api/leaderboard.csv` → CSV standings
* `GET /api/tournaments/:tid/report.md` → Markdown summary
* `GET /api/tournaments/:tid/events` → SSE change notifications
* Replay accepts `?from=<frame>` and returns `X-Frame-Count`.

Live decklists, deck-choice reasons, game reasons/errors, decisions, and activity
are public by default, including in Markdown reports. Set
`YGOSIM_TOURNAMENT_HIDE_LIVE=1` on the game server to restore privacy until each
game finishes: public detail/reports omit live deck data and reasons/diagnostics,
and live decisions/activity return 403. Organizer access bypasses this setting.
Decision fields and activity summaries filter value-shaped secrets while keeping
natural-language strategy text (including Token monsters and board configuration).
Activity never returns raw arguments or result previews. Both log endpoints
accept a non-negative integer `from` (default 0), slice parsed raw rows before
sanitisation, and return total parsed raw rows in `X-Row-Count`; malformed JSON
lines are skipped. Row-count headers are exposed through the server's CORS policy.
Raw tool logs, transcripts, and stderr always require an organizer bearer token
matching the server's `YGOSIM_TOURNAMENT_READ_TOKEN`. Set that variable securely in
the server environment; do not commit it, give it to agents, or put it in a URL.
Without the variable, private reads fail closed. Organizer routes are
`.../games/:gid/tools/:pid`, `.../transcript/:pid`, and `.../stderr/:pid`.

New decision rows store response latency in `ms`, `latencyKind: "response"`,
and separate tool execution/wait duration in `toolMs`. Timing begins when a
prompt is returned to the agent and ends when its action reaches the bridge.
Undelivered prompts have no invented timing sample. `optionIds` and `selected`
preserve resolved IDs so pass rates handle both one-based numbers and exact IDs.
Legacy logs measured tool waiting time; the benchmark report labels legacy or
mixed timing instead of calling it thinking time. Quantiles require logged
samples and cannot be reconstructed from a stored average.

Generate the official aggregate with `pnpm --filter @ygosim/tournament report`.
An explicit `report -- --tournament <validationId>` may include a clearly marked
unscored validation report; explicit legacy IDs produce a historical report.
Wilson win-rate intervals and bootstrap
Bradley–Terry rating intervals are shown, but a sparse or disconnected schedule
still does not support strong model-ranking claims.

```ts
interface Standing { id: string; label: string; model: string; elo: number; played: number; wins: number; losses: number; draws: number;
  points: number; winRate: number; avgTurns: number; avgDecisionMs: number; invalidRate: number; reasonRate: number;
  crashes: number; decks: { name: string; played: number; wins: number }[] }
interface DeckStat { name: string; source: "sample" | "custom"; picks: number; wins: number; pickedBy: Record<string, number> }
```

Points: win 3, draw 1. Elo K=32 starting 1500, games applied in `endedAt` order.
