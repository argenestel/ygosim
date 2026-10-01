# Agent connections

Register Codex's stdio MCP server with the command returned by `/api/agents`.
`codex mcp add --help` supports `-c key=value` overrides, but does not expose a
dedicated persistent approval option. Ensure the saved `~/.codex/config.toml`
entry contains these settings after registration:

```toml
[mcp_servers.ygosim]
command = "node"
args = ["/absolute/path/to/ygosim/packages/mcp/dist/index.js"]
default_tools_approval_mode = "approve"
tool_timeout_sec = 660
```

The server launcher supplies these overrides explicitly for `codex exec`, uses
`-s read-only`, and passes the duel instruction as the positional prompt.
See the [official configuration reference](https://developers.openai.com/codex/config-reference).

Claude Code launches pre-allow game tools with `--allowedTools "mcp__ygosim__*"`.
The installed `claude --help` documents this option as a list of tool names.

`card_info(query="Blue-Eyes", limit=40)` searches names and effect text and
returns one line per card with passcode, type, stats and TCG banlist status.
Existing `code` and `name` lookups retain full text and the five-result limit.
