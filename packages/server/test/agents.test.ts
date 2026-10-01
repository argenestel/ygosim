import { describe, it, expect, afterEach, vi } from "vitest";
import { getAgentInfo } from "../src/agents.js";
import { buildApi } from "../src/server.js";
import { Lobby } from "../src/lobby.js";

afterEach(() => vi.unstubAllEnvs());

describe("Agent Management", () => {
  it("returns only coding agents with valid MCP commands", () => {
    const agents = getAgentInfo("/path/to/mcp/index.js", 12345);
    expect(agents.map(a => a.agent)).toEqual(["claude", "codex"]);
    expect(agents[0].connectCommand).toBe("claude mcp add ygosim -e YGOSIM_URL=ws://localhost:12345 -- node /path/to/mcp/index.js");
    expect(agents[1].connectCommand).toBe("codex mcp add ygosim --env YGOSIM_URL=ws://localhost:12345 -- node /path/to/mcp/index.js");
    for (const agent of agents) {
      expect(Object.keys(agent).sort()).toEqual(["agent", "connectCommand", "installed", "launchable"]);
      expect(typeof agent.installed).toBe("boolean");
      expect(typeof agent.launchable).toBe("boolean");
    }
  });

  it("quotes MCP paths with spaces and apostrophes", () => {
    expect(getAgentInfo("/path/it's a dir/index.js", 12345)[0].connectCommand)
      .toContain("-- node '/path/it'\\''s a dir/index.js'");
  });

  it("disables launching without the environment flag", () => {
    vi.stubEnv("YGOSIM_ALLOW_AGENT_LAUNCH", "");
    expect(getAgentInfo("/path/index.js").every(a => !a.launchable)).toBe(true);
  });

  it("serves the protocol shape and uses the supplied running port", async () => {
    const lobby = new Lobby(async () => { throw new Error("unused"); });
    const app = buildApi(lobby, () => null, () => null, async () => null, undefined, () => 54321);
    const response = await app.request("/api/agents");
    expect(response.status).toBe(200);
    const agents = await response.json();
    expect(agents.map((a: { agent: string }) => a.agent)).toEqual(["claude", "codex"]);
    for (const agent of agents) {
      expect(agent).not.toHaveProperty("kind");
      expect(agent.connectCommand).toContain("YGOSIM_URL=ws://localhost:54321 -- node ");
      expect(agent.connectCommand).toContain("/packages/mcp/dist/index.js");
    }
  });
});
