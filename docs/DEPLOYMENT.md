# Deployment and recovery

This application is an anonymous, in-memory duel service. It does not provide accounts, durable rooms, reconnect tokens, distributed room routing, or restored games after a process restart. A browser disconnect concedes an active game; the browser explains that the session cannot resume and offers a return to the menu. Do not advertise resumable or durable games.

## Build and start

Use Node.js 22 or newer and the pnpm version in the release workflow. Install with `pnpm install --frozen-lockfile`, fetch game data with `bash scripts/fetch-data.sh`, run the release checks, then build with `pnpm build`. Serve `apps/web/dist` through an HTTPS reverse proxy and start the server with `pnpm --filter @ygosim/server start`. The server requires its workspace dependencies, the vendored WASM core, and the `data` directory; copying only the web bundle is not a server deployment.

Route `/api` and `/ws` to the same server instance. Enable WebSocket upgrades and use a proxy idle timeout longer than the configured turn timeout. Keep a single instance or use sticky routing: rooms are process-local. The frontend uses same-origin endpoints in production unless its build-time API configuration overrides them. Never serve the Vite development server publicly: development-only automation hooks are not a production API.

Card art is fetched at runtime from the YGOPRODeck CDN and cached under `packages/data/img`; allow outbound HTTPS and provide a writable cache if you want persistence. The proxy deduplicates downloads, bounds them to 16 active/128 pending requests, limits each body to 3 MiB and each fetch to 10 seconds, and cancels downloads on shutdown. The board requests small textures only for visible front faces; the inspector retains full card art. CDN unavailability can still leave placeholders, so this is not an offline-art deployment. Keep per-card image access logs private: image requests for a player's hand can disclose those card identities to log readers.

| Setting | Default | Meaning |
| --- | --- | --- |
| `PORT` | `7777` | Server listening port; bind/firewall it behind the proxy. |
| `TURN_TIMEOUT_MS` | `180000` | Decision deadline; expiry uses a legal default when one is available. |
| `BOT_DELAY_MS` | `300` | Visual pacing delay for bot actions. |
| `YGOSIM_DATA` | repository `data` directory | Scripts, database, strings, and banlists. |
| `YGOSIM_ALLOW_AGENT_LAUNCH` | unset | Keep unset in public deployments; only the exact value `1` enables local process control. |

Server startup options also cap rooms (100), simultaneous sockets (200), and WebSocket payloads (64 KiB). A token bucket permits a burst of 256 messages, then replenishes at 30 messages per second so fast agent decisions can complete without allowing sustained unbounded traffic. Explicit `messagesPerSecond` uses that value as the burst cap unless `messageBurst` is also supplied. Slow readers are disconnected when their queued WebSocket output exceeds 512 KiB. HTTP API bodies are limited to 64 KiB; card-name resolution accepts at most 100 names of 200 characters each. These are safety defaults, not a measured capacity claim. Apply per-IP connection/rate limits and HTTP request timeouts at the proxy, including limits for expensive card search and image-cache endpoints. Do not expose unlimited anonymous CPU workloads directly to the Internet.

Local agent launch/stop endpoints require the exact enabling flag, a loopback peer, no forwarded-for header, and a local or absent Origin. Forwarding headers never establish local identity. These endpoints are disabled behind a normal public reverse proxy. MCP/JSON-lines agents may connect as ordinary game clients without allowing local process launch. Reserved agent seats remain empty until a real agent connects; no placeholder can start a duel or consume its decisions. Two real MCP clients joining a reserved room and finishing naturally are covered by the opt-in server integration suite. Automatic coding-agent process launch still requires end-to-end release validation and is not part of a verified public release scope. Agent declarations are not authentication: the anonymous protocol lets clients declare their kind.

## Health, shutdown, and failures

`GET /api/health` is a liveness check; `GET /api/ready` returns 200 only when the engine and card database are available, otherwise 503. Use readiness for traffic admission and liveness only to detect a dead process. Give SIGTERM enough grace to close sockets, cancel decisions/siding waits, destroy duel handles, and stop launched agents. Active games are interrupted on shutdown; deploy during a maintenance window or drain new room creation at the proxy first.

Rejected choices retain the decision for retry. Bots use shared legal candidate generation and bounded engine-response fallback. A repeating bot or one that exceeds its decision deadline aborts visibly instead of keeping a room active indefinitely. Room abort diagnostics use keyed, process-local tokens rather than raw private card data or dictionary-testable hashes. Preserve the room reference, seed, deck provenance, and private reproduction artifacts when investigating; public logs must not reveal hidden hands, deck order, agent output, or credentials. Tokens alone cannot reconstruct an unseeded historical incident and change across process restarts.

The synchronous WASM engine runs on the server event loop. Cooperative yielding handles sockets between batches of decisions, but a single expensive core call cannot be interrupted by a JavaScript timer. Isolate instances with CPU/memory limits, monitor latency and memory, and do not infer safe capacity merely from the room cap. Worker isolation and an independently measured load envelope remain prerequisites for a stronger availability guarantee.

## Release evidence

Run `pnpm test`, engine lint, server/MCP typechecks, the web build, and the maintained browser suite. Run the pinned native comparison and the real-deck/bot stress matrix before release and after core/script/database updates. A decision cap or abort is a failed or inconclusive game, never a success. Archive reports together with the core manifest, script/database/banlist revisions, deck hashes, seeds, and build commit. The readiness plan records the current evidence and remaining gates; this document does not certify all modes or every card interaction.
