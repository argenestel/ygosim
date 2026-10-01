import { describe, it, expect, afterEach, vi } from "vitest";
import { getAgentInfo, launchAgent } from "../src/agents.js";
import { buildApi } from "../src/server.js";
import { Lobby } from "../src/lobby.js";

import { spawn } from "node:child_process";
vi.mock("node:child_process", () => ({ execSync: vi.fn(), spawn: vi.fn(() => ({ pid: 123 })) }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("Agent Management", () => {
  it("returns only coding agents with valid MCP commands", () => {
    const agents = getAgentInfo("/path/to/mcp/index.js", 12345);
    expect(agents.map(a => a.agent)).toEqual(["claude", "codex"]);
    expect(agents[0].connectCommand).toBe("claude mcp add ygosim -e YGOSIM_URL=ws://localhost:12345 -- node /path/to/mcp/index.js");
    expect(agents[1].connectCommand).toContain('mcp_servers.ygosim.default_tools_approval_mode="approve"');
    expect(agents[1].connectCommand).toContain('mcp_servers.ygosim.tool_timeout_sec=660');
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

 it("launches Codex with separate config overrides and a positional prompt", async () => {
   vi.stubEnv("YGOSIM_ALLOW_AGENT_LAUNCH", "1");
   const path = '/path/with "quotes"/index.js';
   expect(await launchAgent(path, "codex", "codex-test")).toEqual({ ok: true, pid: 123 });
   expect(spawn).toHaveBeenCalledWith("codex", [
     "exec", "--skip-git-repo-check", "-s", "read-only",
     "-c", 'mcp_servers.ygosim.command="node"',
     "-c", `mcp_servers.ygosim.args=${JSON.stringify([path])}`,
     "-c", 'mcp_servers.ygosim.default_tools_approval_mode="approve"',
     "-c", "mcp_servers.ygosim.tool_timeout_sec=660",
     "Join ygosim room codex-test (seat 1) and play the duel to the end using the ygosim tools.",
   ]);
 });
 it("pre-allows Claude's ygosim tools", async () => {
   vi.stubEnv("YGOSIM_ALLOW_AGENT_LAUNCH", "1");
   expect((await launchAgent("/mcp.json", "claude", "claude-test")).ok).toBe(true);
   expect(spawn).toHaveBeenCalledWith("claude", ["-p", expect.any(String), "--mcp-config", "/mcp.json", "--allowedTools", "mcp__ygosim__*"]);
 });
