import { describe, it, expect } from "vitest";
import { getAgentInfo } from "../src/agents.js";

describe("Agent Management", () => {
  it("should return agent info with installed and launchable flags", () => {
    const mpcPath = "/path/to/mcp/index.js";
    const agents = getAgentInfo(mpcPath);

    expect(agents).toBeInstanceOf(Array);
    expect(agents.length).toBeGreaterThan(0);

    // Should always have bot
    const bot = agents.find(a => a.kind === "bot");
    expect(bot).toBeDefined();
    expect(bot?.installed).toBe(true);
    expect(bot?.launchable).toBe(true);

    // Claude and Codex may or may not be installed
    const claude = agents.find(a => a.kind === "claude");
    const codex = agents.find(a => a.kind === "codex");

    expect(claude).toBeDefined();
    expect(codex).toBeDefined();

    // Each should have a connectCommand
    for (const agent of agents) {
      expect(agent.connectCommand).toBeDefined();
      expect(typeof agent.connectCommand).toBe("string");
    }
  });

  it("should indicate when agents are not launchable without env flag", () => {
    const mpcPath = "/path/to/mcp/index.js";
    const originalFlag = process.env.YGOSIM_ALLOW_AGENT_LAUNCH;

    try {
      delete process.env.YGOSIM_ALLOW_AGENT_LAUNCH;
      const agents = getAgentInfo(mpcPath);

      const claude = agents.find(a => a.kind === "claude");
      const codex = agents.find(a => a.kind === "codex");

      // If installed, should not be launchable without env flag
      if (claude?.installed) {
        expect(claude.launchable).toBe(false);
      }
      if (codex?.installed) {
        expect(codex.launchable).toBe(false);
      }
    } finally {
      if (originalFlag) process.env.YGOSIM_ALLOW_AGENT_LAUNCH = originalFlag;
    }
  });
});
