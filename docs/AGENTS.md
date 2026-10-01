# Playing YGO Simulator with an agent

The MCP bridge and `ygosim-agent` JSON-lines CLI share one set of tools and keep
one game session per process. The game server must already be running. MCP uses
stdin/stdout; it connects to the game's WebSocket and HTTP APIs separately.

## Build and verify

Use Node.js 22+ and pnpm. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @ygosim/mcp build
pnpm --filter @ygosim/mcp typecheck
pnpm --filter @ygosim/mcp test
```

The tests use a fake HTTP/WebSocket server; no live duel engine is needed. They
also build and launch both executable entrypoints and use an MCP SDK client to
verify initialization, tool discovery, tool calls, and error responses over stdio.
There is no separate lint configuration in this package; typecheck runs strict
TypeScript checks.

Start the game server separately using the server package's development command:

```sh
pnpm --filter @ygosim/server dev
```

Default game URL: `ws://localhost:7777` (WebSocket path `/ws`, HTTP API `/api`).
Set `YGOSIM_URL` to use another server. `ws:`, `wss:`, `http:`, and `https:` URLs
are supported, including an explicit `/ws` path. `YGOSIM_NAME` sets the player
name (default `agent`). The bridge does not start the game server.

Launch the MCP server directly after building:

```sh
YGOSIM_URL=ws://localhost:7777 node packages/mcp/dist/index.js
```

Keep stdout reserved for the transport. Each process represents one agent;
start separate processes for separate players. Rooms and pending prompts are
held in memory and are not restored after a process restart.

## Claude Code setup

From the repository root, register the built stdio server with an absolute path:

```sh
claude mcp add --scope user --env YGOSIM_URL=ws://localhost:7777 \
  --transport stdio ygosim -- node "$PWD/packages/mcp/dist/index.js"
claude mcp list
```

Use `/mcp` in Claude Code to check the connection. For long polls beyond the
client's tool timeout, set `MCP_TOOL_TIMEOUT=660000` when starting Claude Code,
or request a shorter `timeoutSec`, such as 30 seconds.

The command syntax follows [Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp).

## Codex CLI setup

Add this entry to `~/.codex/config.toml`. Replace `/absolute/path/to/ygosim` with
the repository's absolute path; TOML does not expand `$PWD` in `args`.

```toml
[mcp_servers.ygosim]
command = "node"
args = ["/absolute/path/to/ygosim/packages/mcp/dist/index.js"]
startup_timeout_sec = 10
tool_timeout_sec = 660

[mcp_servers.ygosim.env]
YGOSIM_URL = "ws://localhost:7777"
YGOSIM_NAME = "Codex"
```

Restart Codex CLI and run `codex mcp list` to verify registration. The larger
tool timeout allows the maximum 600-second game long-poll to finish. Configuration
keys follow [the official Codex MCP documentation](https://developers.openai.com/codex/mcp).

## Tools

| Tool | Purpose and arguments |
| --- | --- |
| `list_rooms` | List rooms, named players, and available sample deck names. |
| `create_room` | Create a room; `vsAI` defaults to `true`, `level` is `easy`, `normal` (default), or `hard`. Choose one deck source below. |
| `join_room` | Join by `roomId`, using the same deck inputs as `create_room`. The game server may seat you as a spectator if the room is full. |
| `wait_for_turn` | Long-poll for your pending prompt, duel end, or server error. `timeoutSec` defaults to 60 and ranges from 1 to 600. Returns new events, a concise named board table, chat, and numbered options. Call again after timeout. |
| `get_state` | Immediately show cached state, pending prompt, new events, and chat. Does not request a new server snapshot. |
| `act` | `choose` contains 1-based option numbers (`[1]`) or exact string IDs (`["summon:dragon"]`). Optional `promptId` rejects stale decisions. `wait` defaults to `true`; `timeoutSec` controls waiting for the next decision. |
| `card_info` | Look up full card text and stats using `name` (partial names supported, up to five results) or `code`. |
| `chat` | Send `text` (1–500 characters) to the room. |
| `surrender` | Send a concession; call `wait_for_turn` for the confirmed result. |

Visible cards are resolved through the card API and rendered by name. Hidden cards
remain hidden. If the card database is unavailable, the board uses an explicit
`Unknown card (#passcode)` fallback rather than inventing a name or effect.
Board lookups retry transient HTTP failures on subsequent checks.

`get_state`, `wait_for_turn`, and waiting `act` consume the event/chat buffer;
they show events since the last report, with at most 40 recent event lines.
The latest board and pending prompt remain available on subsequent checks.

### Deck inputs

For `create_room` and `join_room`, provide exactly one source, or omit all inputs
to use the first sample deck:

- `deck`: sample name from `list_rooms`, matched case-insensitively (partial names supported).
- `ydk`: raw YDK text with `#main`, `#extra`, and `!side` sections.
- `main`: array of positive integer passcodes, plus optional `extra` and `side` arrays.

The game server validates deck legality (main 40–60 cards, extra/side at most 15,
at most three copies per card, and any configured card rules). The bridge rejects
ambiguous deck sources; do not mix `deck`, `ydk`, and `main`.

Example tool inputs:

```json
{"vsAI":true,"level":"hard","deck":"Dragon Starter"}
```

Use an actual sample name from `list_rooms`; the example name is illustrative.
A prompt's numeric option label is different from a numeric-looking string ID:
`choose: [2]` selects the second displayed option; `choose: ["2"]` selects the
exact wire ID `2`. IDs are opaque. Use only choices in the current prompt and
respect its min/max selection counts; `choose: []` is valid when min is zero.

## JSON-lines CLI

After building, run:

```sh
YGOSIM_URL=ws://localhost:7777 node packages/mcp/dist/cli.js
```

The package also declares the executable names `ygosim-mcp` and `ygosim-agent`.
Each nonempty stdin line is a request; each response is a single JSON stdout
line. The CLI processes requests sequentially in one persistent game session.
Use `act` with `wait:false` when you want to send an action separately from
`wait_for_turn`. Blank lines are ignored. EOF closes the session after queued
requests finish. SIGINT/SIGTERM close the connection.

```jsonl
{"id":1,"tool":"help"}
{"id":2,"tool":"list_rooms"}
{"id":3,"tool":"create_room","args":{"vsAI":true,"level":"normal"}}
{"id":4,"tool":"wait_for_turn","args":{"timeoutSec":30}}
{"id":5,"tool":"card_info","args":{"name":"Blue-Eyes White Dragon"}}
{"id":6,"tool":"act","args":{"choose":[1],"wait":false}}
{"id":7,"tool":"wait_for_turn","args":{"timeoutSec":30}}
```

Send choices after reading the prompt; option 1 above is only an illustration.
Responses are `{ "id": 1, "ok": true, "text": "..." }` or
`{ "id": 1, "ok": false, "error": "..." }`. `help` returns a `tools` array
with the same nine tools and argument names as MCP. Malformed input produces an
error response without ending the process. A server error during a long-poll is
shown in the report; a rejected action retains or reissues its prompt for retry.

## Recommended play prompt

> Play one complete Yu-Gi-Oh! duel using the ygosim tools. Call `list_rooms` to
> discover sample deck names, then `create_room` with `vsAI:true`, `level:"normal"`,
> and a sample deck name. Call `wait_for_turn` with `timeoutSec:30`. Read the board
> and current prompt, use `card_info` by card name for effects you do not know,
> and choose only legal options from that prompt with `act`. Use the displayed
> option numbers and pass `promptId` to guard against stale choices. Respect
> selection counts. Repeat waiting after timeouts and between decisions until
> the report confirms DUEL OVER. If an action is rejected, read the current
> prompt and retry a legal choice. Use card names and tool names when explaining
> decisions. Never infer hidden cards or invent card effects. If the connection
> fails, report that the session was interrupted. At duel end, report the result
> and one or two key decisions. Surrender only if I ask you to concede.
