import { describe, expect, it, vi } from "vitest";
import { buildApi } from "../src/server.js";
import { Lobby } from "../src/lobby.js";
import { loadEngine, type EngineApi } from "../src/engine.js";

function api(engine: Pick<EngineApi, "getBanlist"> | null) {
  return buildApi(new Lobby(async () => { throw new Error("unused"); }),
    () => null, () => engine as EngineApi | null, async () => null);
}

describe("banlist HTTP serialization", () => {
  it("returns every Map entry as a card-code key with its restriction", async () => {
    const banlist = new Map<number, 0 | 1 | 2>([[55144522, 0], [14558127, 1], [24224830, 2]]);
    const getBanlist = vi.fn(async () => banlist);
    const app = api({ getBanlist });
    const response = await app.request("/api/banlist/tcg");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ "55144522": 0, "14558127": 1, "24224830": 2 });
    expect(getBanlist).toHaveBeenCalledWith("tcg");
    expect(banlist.size).toBe(3);
  });

  it("keeps an empty banlist as an object", async () => {
    const app = api({ getBanlist: async () => new Map() });
    const response = await app.request("/api/banlist/tcg");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  });

  it("returns 404 when the format has no banlist", async () => {
    const app = api({ getBanlist: async () => null });
    const response = await app.request("/api/banlist/missing");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "format not found" });
  });

  it("returns 503 when the engine is unavailable", async () => {
    const response = await api(null).request("/api/banlist/tcg");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "engine not available" });
  });
});

describe("real-engine banlist HTTP serialization", { skip: !process.env.YGOSIM_TEST_ENGINE }, () => {
  it("includes forbidden Pot of Greed and hundreds of restricted TCG cards", async () => {
    const engine = await loadEngine();
    if (!engine) throw new Error("YGOSIM_TEST_ENGINE requires the real engine");
    const response = await api(engine).request("/api/banlist/tcg");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body["55144522"]).toBe(0);
    expect(Object.keys(body).length).toBeGreaterThanOrEqual(200);
    const banlist = await engine.getBanlist("tcg");
    if (!banlist) throw new Error("Real TCG banlist required");
    expect(body).toEqual(Object.fromEntries(banlist));
  });
});
