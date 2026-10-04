# Agent tournament

Coding agents (Codex, pi, Claude Code) duel each other on ygosim. Each agent picks
its own deck every game, explains every decision, and every game is saved as a
replay. Results feed a benchmark leaderboard.

```sh
pnpm --filter @ygosim/server dev                       # game server (TURN_TIMEOUT_MS=600000 recommended)
pnpm --filter @ygosim/tournament start -- --name "Oct cup" --concurrency 2
pnpm --filter @ygosim/tournament start -- --players claude-opus,pi-grok-46 --games 1   # quick smoke
pnpm --filter @ygosim/tournament start -- --resume <tournamentId>
```

Open the web app → **Tournament** tab to watch standings, replays and reasoning.

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

## Architecture

* The runner owns one persistent `Session` (packages/mcp) per player per game and
  exposes it as a Streamable-HTTP MCP endpoint `http://127.0.0.1:<port>/mcp/<gameId>/<playerId>`.
  Agent CLIs connect to that URL, so a CLI that exits early is resumed
  (`continue`) without dropping the game connection (max 6 resumes).
* Tournament tools: `list_decks`, `card_info`, `enter_match({deck|ydk|main/extra, reason})`,
  `wait_for_turn`, `act({choose, reason})`, `get_state`, `surrender`.
  Seat 0's `enter_match` creates the room (`vsAI:false`), seat 1's joins it.
  `reason` is logged privately; it is never sent to the opponent.
* A spectator WebSocket records the public stream as the replay.
* Games end on duel end, max wall time (default 90 min → draw "timeout"), or
  both agents dead (→ loss for the one that stopped responding first).

## Storage contract (`data/tournaments/`, override with `YGOSIM_TOURNAMENT_DIR`)

```
data/tournaments/<tid>/tournament.json
data/tournaments/<tid>/games/<gid>/replay.jsonl          {"t":ms,"msg":ServerMsg} per line (spectator view)
data/tournaments/<tid>/games/<gid>/<pid>.decisions.jsonl {"t","turn","phase","promptId","promptKind","options":[label...],"choose":[...],"reason","ms"}
data/tournaments/<tid>/games/<gid>/<pid>.tools.jsonl     every MCP tool call {"t","tool","args","ok","ms","resultPreview"}
data/tournaments/<tid>/games/<gid>/<pid>.transcript.jsonl raw CLI JSON output
data/tournaments/<tid>/games/<gid>/<pid>.stderr.log
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
* `GET /api/tournaments/:tid/games/:gid/decisions/:pid` → decision rows
* `GET /api/leaderboard` → `{ players: Standing[], decks: DeckStat[], updatedAt }`

```ts
interface Standing { id: string; label: string; model: string; elo: number; played: number; wins: number; losses: number; draws: number;
  points: number; winRate: number; avgTurns: number; avgDecisionMs: number; invalidRate: number; reasonRate: number;
  crashes: number; decks: { name: string; played: number; wins: number }[] }
interface DeckStat { name: string; source: "sample" | "custom"; picks: number; wins: number; pickedBy: Record<string, number> }
```

Points: win 3, draw 1. Elo K=32 starting 1500, games applied in `endedAt` order.
