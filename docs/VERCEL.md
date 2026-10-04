# Vercel services deployment

The root `vercel.json` builds two publicly routed services, named as confirmed by the user: the Vite `ygoweb` frontend and the Hono/Node `ygoserver` backend. Import the repository with the project root set to the repository root, not `apps/web`. The root services configuration owns public routing; build settings live inside each service. Full multiplayer support is required, but the persistent duel runtime described below is not yet configured.

## Public routes and bindings

- `/api/*` routes to `ygoserver`, preserving the `/api` prefix already used by Hono.
- `/ws` routes to `ygoserver`, preserving the existing WebSocket upgrade path.
- Other paths route to `ygoweb`, including its static assets.

There are no internal service calls in this topology. Vite produces browser assets; browsers use same-origin `/api` and `/ws` public endpoints. A runtime binding cannot be used in the static frontend or injected into its build. Therefore no unused binding or public `VITE_*` copy of an internal URL is declared. If a server-side frontend proxy or another backend is added, declare its binding on that caller and read the generated URL only in its runtime function.

Leave `VITE_WS_URL` unset for this same-domain deployment. It is only needed for an explicitly separate public WebSocket backend. Do not set a binding variable manually.

## Backend entrypoint and assets

`packages/server/src/vercel.ts` exports the HTTP server returned by the existing server startup function, retaining its `ws` upgrade handlers. Standalone `src/main.ts` still runs the existing local server. The backend build fetches the pinned card scripts plus current databases, banlists, and strings. Function inclusion patterns package runtime Lua/data, sample decks, and vendored WASM modules without repository metadata or native build archives. The engine import uses a literal package name for dependency tracing. Vercel's image cache uses its writable temporary directory and is not durable.

Do not enable local coding-agent process launch on Vercel. Run MCP clients externally against the public game endpoint instead.

## Important runtime limitation

Vercel currently supports Node WebSockets in public beta, but each connection is pinned only to its own function instance. Separate players, spectators, and HTTP requests can reach different instances. This simulator stores its lobby, rooms, pending prompts, and live WASM handles in process memory, without shared coordination or persistent reconnect. Merely deploying two services does not make multiplayer reliable under this runtime.

Connections also close when the function duration limit is reached, and this application cannot resume those duels. Configure any duration limit according to your actual Vercel plan; no longer duration or single-instance guarantee is assumed here. Solo bot games use one client connection but remain subject to duration limits and instance recycling. This configuration is a deployment candidate, not certification of production multiplayer on Vercel.

For reliable production multiplayer, choose a persistent game-server host with single-instance/sticky routing, or implement a durable duel coordinator and cross-instance connection routing before relying on Vercel scaling. An ordinary Redis room list alone cannot migrate a live WASM duel.

## Validation and confirmation

After confirming the topology, use `vercel dev -L` to run the services together, then validate a preview deployment's data loading, assets, `/api/ready`, and `/ws` upgrades. No Vercel build, local service run, or deployment has been verified for this configuration; the user's no-testing instruction remains in effect.

References: [services](https://vercel.com/docs/services), [service routing](https://vercel.com/docs/services/routing), [bindings](https://vercel.com/docs/services/bindings), and [WebSockets](https://vercel.com/docs/functions/websockets).
