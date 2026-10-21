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

## Six-agent Bubble Cup

The requested cup uses Pi Grok 4.6 at `xhigh`, Pi GPT-6 Luna through
`openai-codex` at `max`, Codex GPT-6.1 Sol at `medium`, Pi DeepSeek v4.1 Flash
and GLM 5.3 Flash through Fireworks at `high`, and Antigravity Gemini 3.8 Flash
through the native `agy` CLI at `high`. Every entrant builds a custom TCG deck.

```sh
node scripts/run-scored-cup.mjs --players pi-grok-46-xhigh,pi-luna-max,codex-sol,pi-deepseek-flash,agy-gemini-flash,pi-glm-flash
```

The launcher runs three unscored validation games covering all six entrants,
then starts the scored 15-game round robin plus final only if validation passes.
It uses the server at `ws://localhost:7788`, concurrency 3, and a 90-minute game
cap by default. Override these using `--server`, `--concurrency`, and
`--max-minutes`. Phase state and runner logs are saved under `.omx/state/` and
`.omx/logs/`. Failed validation stops the launcher and never produces scored
results. Keep the source unchanged between validation and scoring.

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
in a naturally completed game or a `time-lp` adjudication. A `time-lp` game
qualifies only when both players registered decks and each made at least one
timed decision. Equal-LP timeout draws, forfeits, infrastructure failures, and
surrenders do not qualify. The console names players still missing evidence.
Validation runs never enter the all-time leaderboard or default benchmark report.
Those official aggregates require `scored: true`; unmarked legacy/demo records
remain viewable by tournament ID but do not silently enter the new rankings.

Scored CLI launches require `--validated-by <id>` from a passing validation with
the same source hash, server URL, decision limits and timeout policy, Node version, CLI versions,
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
decision limits, wall-time budget, timeout policy (`audit.onTimeout`), and schedule configuration; emitted model
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
actions instead of silently auto-playing. At the wall-time cap, `--on-timeout lp`
(the default) awards the game to the player with more LP, with reason `time-lp`;
equal LP remains a draw with reason `timeout`. Use `--on-timeout draw` to draw
regardless of LP. Finished games record final LP by player ID; timeout console
lines print the reason and LP in seat order. Adjudication uses the server state and authenticated tournament
controls. Legacy audits without `onTimeout` mean `draw`, including for validation
matching and resume; changing the policy requires fresh validation. An exhausted agent can forfeit only after both players register decks. The server
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

`codex-sol` and `codex-luna-max` set `codeMode: true`: these models need Codex code mode
to reach the ygosim MCP tools. Shell, web search, and browser tools stay disabled,
and the Codex sandbox stays read-only, but code mode can execute code inside the
filesystem sandbox. This is a weaker isolation guarantee for that entrant;
the prompt instructs it to use only the game MCP tools and avoid network/file
access attempts. Codex entrants without this opt-in keep code mode disabled, including stored
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
  LP adjudication "time-lp", or equal-LP draw "timeout"; `--on-timeout draw` always draws), or agent exhaustion after match entry. Shared
  infrastructure errors remain unscored and pause further launches.

## HTTP API (game server)

The read-only HTTP API exposes normalized tournament resources for the web client.
High-level resources come first; the replay and per-seat log routes are lower-level
building blocks.

```ts
type TournamentKind = "scored" | "validation" | "legacy";
type TournamentState = "finished" | "live" | "paused";
type Provider = "xai" | "deepseek" | "zai" | "google" | "anthropic" | "openai" | "unknown";

interface PlayerRef {
  id: string; label: string; cli: "codex" | "pi" | "claude" | "agy"; model: string;
  effort?: string; codeMode?: boolean; provider: Provider; host?: "Fireworks";
}
interface ProviderInfo { provider: Provider; host?: "Fireworks" }
interface Leader { id: string; label: string; points: number; wins: number; losses: number; draws: number }
interface Progress { done: number; total: number; live: number; errors: number }
interface TournamentSummary {
  id: string; name: string; createdAt: string; status: "running" | "done"; paused: boolean;
  kind: TournamentKind; state: TournamentState; active: boolean; format: Tournament["format"];
  progress: Progress; done: number; total: number; players: PlayerRef[];
  leader: Leader | null; champion: string | null;
}
interface PublicGame extends Game {
  durationMs?: number;
  decks: Record<string, Game["decks"][string] & { title: string }>;
  live?: { turn: number; phase: string; turnPlayer: 0 | 1; lp: [number, number]; at: string };
}
interface TournamentGameResponse {
  tournament: {
    id: string; name: string; kind: TournamentKind; state: TournamentState;
    format: Tournament["format"]; maxMinutes?: number; onTimeout?: "lp" | "draw";
  };
  players: [PlayerRef, PlayerRef];
  game: PublicGame;
}
```

`GET /api/tournaments` returns `TournamentSummary[]`. A scored record has
`kind: "scored"`; an explicit unscored validation has `kind: "validation"`; a
record without either marker is `kind: "legacy"`. The display name removes one
trailing ` (unscored validation)` suffix. A finished record has `state: "finished"`.
A running record has `state: "live"` only while its runner lock belongs to a live
process; otherwise it is `state: "paused"`. `progress.live` counts running games
only for the live state. `leader` is selected from completed-game standings by
points, then Elo, and is null when no game is done. `champion` is populated only
for a finished tournament: a completed final winner, then a completed series
winner, then a unique points leader; ties produce null.

`GET /api/tournaments/:tid` returns `Tournament` with the normalized summary
fields above, enriched `players`, `standings`, and `games: PublicGame[]`. A game's
`durationMs` is derived from its start and end timestamps. Each visible deck keeps
its stored fields and adds the concise `title`; legacy generated custom-deck names
use the first clause of their reason. A running replay may add the latest public
`live` board state without hands or decks. With live hiding enabled, a non-done
game returns `decks: {}` and omits reasons, errors, and live board data.

`active` means that a runner currently owns the tournament lock with a live
process. Missing, empty, malformed, and dead-owner locks are inactive, even when
the stored tournament status is `running`. A normal exit, game limit,
infrastructure failure, or signal settles interrupted games back to `pending`;
the tournament is marked done only when every game is done. Otherwise it remains
running and records `paused: true` with an ISO `pausedAt` timestamp. Resume clears
both pause fields and retries unfinished or errored games.

`GET /api/tournaments/:tid/games/:gid` returns `TournamentGameResponse`; `players`
follow the game's seat order, rather than tournament registration order. Its
`tournament` object carries only the context needed by a game page, and `game`
uses the same enriched visibility rules as tournament detail.

`GET /api/tournaments/:tid/games/:gid/timeline?include=tools&cursor=<cursor>`
returns `{ events, cursor, final }`. Events merge both seats and sort by relative
milliseconds, with seat 0 first for equal timestamps:

```ts
type TimelineEvent =
  | { type: "deck"; at: number; seat: 0 | 1; player: string; title: string;
      size: { main: number; extra: number; side: number }; reason: string }
  | { type: "decision"; at: number; seat: 0 | 1; player: string; turn?: number;
      phase?: string; prompt: { kind: string; label: string }; choice: string[];
      reason?: string; thinkMs?: number }
  | { type: "tool"; at: number; seat: 0 | 1; player: string; tool: string;
      ok: boolean; ms: number; summary: string }
  | { type: "result"; at: number; winner: string | null; reason: string;
      lp?: Record<string, number>; turns?: number };
```

Numeric choices use one-based option numbers, string choices resolve through
`optionIds`, empty choices become `Pass`, and an unknown choice is returned as a
string. Prompt kinds have human-readable labels where known and a spaced fallback
otherwise. Deck events use the successful `enter_match` tool timestamp, or zero
when no successful entry exists. Tool events are included only when
`include=tools` is requested and use the same sanitized summaries as the activity
route; raw arguments and result previews never appear. A done game emits one
result event at its duration, or at the last event when duration is unavailable.
`final` is true only for terminal `done` and `error` games.

The timeline cursor is scoped to one tournament and game. Clients should treat it
as opaque and pass it back unchanged. Internally,
the offsets track physical source rows, including complete malformed JSON lines,
while byte lengths detect a shrunk or truncated source even when its row count is
unchanged. A shrunk source resets that seat's offset. Cursors with invalid
base64url, scope, version, or fields return 400. Polling with a cursor does not
repeat previously emitted decisions, tools, deck events, or results.

`GET /api/leaderboard` returns `{ players: (Standing & ProviderInfo)[], decks: DeckStat[], updatedAt }`.
Only `scored: true` tournaments contribute. `GET /api/leaderboard.csv` returns
the same standings as CSV. `GET /api/tournaments/:tid/report.md` returns a
Markdown report, and `GET /api/tournaments/:tid/events` streams SSE change
notifications. `GET /api` lists the available endpoint paths.

The following low-level routes are per-seat routes and require `:pid` to be one
of the game's two player IDs:

* `GET /api/tournaments/:tid/games/:gid/decisions/:pid?from=N` → public decision rows
* `GET /api/tournaments/:tid/games/:gid/activity/:pid?from=N` → sanitized activity rows
* `GET /api/tournaments/:tid/games/:gid/tools/:pid` → organizer-only raw tool rows
* `GET /api/tournaments/:tid/games/:gid/transcript/:pid` → organizer-only transcript
* `GET /api/tournaments/:tid/games/:gid/stderr/:pid` → organizer-only stderr

`GET /api/tournaments/:tid/games/:gid/replay?from=N` is game-level and returns
replay frames with `X-Frame-Count`. Under `YGOSIM_TOURNAMENT_HIDE_LIVE=1`, public
decisions, activity, and timeline reads for every non-done game return 403;
organizer access bypasses this setting. Raw tools, transcripts, and stderr always
require the organizer bearer token from `YGOSIM_TOURNAMENT_READ_TOKEN`; the
credential is matched as `Authorization: Bearer <token>`, fails closed when the
environment variable is absent, and must never be placed in a URL. Decision and
activity responses keep natural-language strategy text while filtering
value-shaped secrets; activity never returns raw arguments or result previews.
The `from` query slices the parsed raw rows before public sanitization, malformed
JSON lines are skipped, and `X-Row-Count` reports the raw row count. The server
exposes that header through its CORS policy. Symlinks and traversal outside the
tournament root are rejected.

`enter_match` accepts an optional descriptive `name`: strip control characters,
trim, and use 1–40 characters. The stored deck name prefers that value, then the
sample name, then the generated custom-deck label. API titles preserve descriptive
names; legacy `Custom deck <hash>` titles use the first reason clause (before
`. `, `:`, `;`, ` — `, or newline), shortened to 48 characters at a word boundary
with an ellipsis. Empty reasons retain the stored name.

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
  paused?: boolean; pausedAt?: string;
  format: "round-robin+final" | "best-of-three";
  players: { id: string; label: string; cli: "codex" | "pi" | "claude" | "agy"; model: string; effort?: string; codeMode?: boolean }[];
  games: Game[];
  scored?: boolean;
  deckPolicy?: "choice" | "custom-only";
  audit?: { revision: string; sourceHash: string; dirty: boolean; node: string; cliVersions: Record<string, string>;
    server: string; decisionTimeoutMs: number; maxInvalid: number; maxMinutes?: number; onTimeout?: "lp" | "draw";
    seed: number; cycles: number; mirrored: boolean; validatedBy?: string; deckPolicy?: "choice" | "custom-only" };
  validation?: { passed: boolean; checkedPlayers: string[]; missingPlayers: string[] };
  series?: { bestOf: 3; seed: number; wins: Record<string, number>; winner: string | null; complete: boolean };
}
interface Game {
  id: string; stage: "round-robin" | "final" | "series"; round: number;
  seats: [string, string];                 // player ids, seat 0 goes first-chooser
  status: "pending" | "running" | "done" | "error";
  winner: string | null; reason?: string;  // reason from engine, or "time-lp" / "timeout" / "agent-crash"
  startedAt?: string; endedAt?: string; turns?: number;
  lp?: Record<string, number>;             // final LP by player id; absent on legacy games
  decks: Record<string, { name: string; source: "sample" | "custom"; reason: string; main: number[]; extra: number[]; side?: number[]; fingerprint?: string }>;
  stats: Record<string, { decisions: number; avgDecisionMs: number; invalid: number; toolCalls: number; resumes: number; reasonsGiven: number; timedDecisions?: number; latencyKind?: "response" }>;
  error?: string;
  seed?: number; cycle?: number; attempt?: number; models?: Record<string, string>; efforts?: Record<string, string>;
}
```

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
