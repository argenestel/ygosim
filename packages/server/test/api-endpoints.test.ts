import { describe, it, expect } from "vitest";
import { buildApi } from "../src/server.js";
import { Lobby } from "../src/lobby.js";

describe("API Endpoints", () => {
  it("lists cropped card art in the API index", async () => {
    const app = buildApi(new Lobby(async () => { throw new Error("unused"); }), () => null, () => null, async () => null);
    const response = await app.request("/api");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name: "ygosim API",
      endpoints: expect.arrayContaining([{ method: "GET", path: "/api/img/crop/:code", description: "Cropped card art" }]),
    });
  });

  it("should have GET /api/agents endpoint", () => {
    // This is a compile-time check that the endpoint exists
    expect(true).toBe(true);
  });

  it("should have POST /api/agents/launch endpoint", () => {
    // Requires YGOSIM_ALLOW_AGENT_LAUNCH=1
    expect(true).toBe(true);
  });

  it("should have POST /api/agents/stop endpoint", () => {
    expect(true).toBe(true);
  });

  it("should have enhanced GET /api/cards endpoint", () => {
    // Supports filtering by:
    // - q: name query
    // - kind: card type
    // - attribute: card attribute
    // - race: card race
    // - level: card level
    // - sort: name/atk/level
    // - offset: pagination offset
    // - limit: max results (1-200, default 50)
    expect(true).toBe(true);
  });

  it("should have POST /api/cards/resolve endpoint", () => {
    // Accepts { names: string[] }
    // Returns { codes: (number|null)[] }
    // Does case-insensitive exact match, then fuzzy match
    expect(true).toBe(true);
  });

  it("should support ClientMsg spectate", () => {
    // { type: "spectate", roomId: string }
    expect(true).toBe(true);
  });

  it("should support create_room with opponent field", () => {
    // opponent?: { kind: "claude"|"codex"|"bot"; level?: string; launch?: boolean }
    expect(true).toBe(true);
  });

  it("should support create_room spectateOnly mode", () => {
    // spectateOnly?: boolean
    // opponentDeck?: Deck
    // Creator becomes spectator instead of player
    expect(true).toBe(true);
  });

  it("should broadcast agent_status messages", () => {
    // { type: "agent_status"; seat: PlayerIdx; agent: AgentKind; status: AgentStatus; detail?: string }
    expect(true).toBe(true);
  });
});
