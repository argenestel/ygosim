# Vercel frontend and Render game server

The public `ygoweb` frontend runs on Vercel. The public `ygoserver` game runtime is hosted separately at `https://ygoserver.onrender.com`, as provided by the user. Do not deploy a second instance-local game backend on Vercel alongside it.

Import the repository into Vercel with the project root set to the repository root, not `apps/web`. The root `vercel.json` declares the `ygoweb` Vite service and owns public routing. Build settings live inside that service.

## Routing

- `/api/*` on the frontend origin is externally rewritten to `https://ygoserver.onrender.com/api/*`. This preserves the Hono `/api` prefix, query strings, HTTP methods, and existing card-art URLs.
- Production browser WebSockets connect directly to `wss://ygoserver.onrender.com/ws`, avoiding Vercel Function connection-duration limits and a second game runtime.
- Other Vercel paths route to `ygoweb`, including its static assets.
- Local development retains same-origin `/ws` and `/api`, proxied by Vite to the local server.

The optional build-time `VITE_WS_URL` override still takes precedence. Remove any stale override in Vercel or set it to `wss://ygoserver.onrender.com/ws`, then redeploy the frontend. No extra variable is needed for the checked-in Render default.

There are no internal Vercel service-to-service calls in this topology, so no unused binding is declared. Browser requests use public routes; external Render hosting is not an internal Vercel service. Do not publish generated internal binding URLs into browser assets.

## Render configuration

Use one paid, always-on Node Web Service named `ygoserver`, with branch `main` and a blank Root Directory so sibling workspace packages remain available.

Build command:

```sh
npx --yes pnpm@11.1.2 install --frozen-lockfile --prod=false && bash scripts/fetch-data.sh
```

Start command:

```sh
node --import ./packages/server/node_modules/tsx/dist/loader.mjs packages/server/src/main.ts
```

Use `NODE_VERSION=22.23.3`, `NODE_ENV=production`, and `YGOSIM_ALLOW_AGENT_LAUNCH=0`. Leave `PORT` unset; Render supplies it. Use `/api/ready` as the health check. Keep a single instance and disable sleeping/horizontal autoscaling. Manual deployments avoid unexpectedly ending games on every push.

The build downloads game data. Art caches are writable but ephemeral unless separately persisted. External MCP clients should use `YGOSIM_URL=https://ygoserver.onrender.com`; local coding-agent process launch stays disabled.

## Remaining limits and validation

Rooms, pending prompts, and live WASM handles remain process-local. This hosting arrangement directs clients to the same persistent server, but deploys, crashes, or restarts still lose active games. It does not implement durable reconnect, authentication, or multi-instance coordination. Persistent disks alone cannot restore live WASM duels.

The Render URL was supplied by the user. Neither its readiness nor the integrated Vercel/browser routing has been probed, built, or tested here because the user's no-testing instruction remains in effect. This is configuration and source wiring, not a verified live-deployment claim.

References: [Vercel external rewrites](https://vercel.com/docs/routing/rewrites), [Render WebSockets](https://render.com/docs/websocket), and [Render monorepos](https://render.com/docs/monorepo-support).
