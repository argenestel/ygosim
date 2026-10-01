import { execSync, spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import type { AgentKind, AgentStatus } from "@ygosim/protocol";

export interface AgentInfo {
  kind: AgentKind;
  installed: boolean;
  launchable: boolean;
  connectCommand: string;
}

export interface AgentProcess {
  process: ChildProcess;
  kind: AgentKind;
  roomId: string;
  seat?: number;
}

const agentProcesses = new Map<string, AgentProcess>();

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function getAgentInfo(mpcPath: string): AgentInfo[] {
  const agents: AgentInfo[] = [];

  // Check for Claude Code
  const claudeInstalled = commandExists("claude");
  const claudeLaunchable = claudeInstalled && process.env.YGOSIM_ALLOW_AGENT_LAUNCH === "1";
  agents.push({
    kind: "claude",
    installed: claudeInstalled,
    launchable: claudeLaunchable,
    connectCommand: claudeInstalled
      ? `claude mcp add ygosim "node ${mpcPath}"`
      : "Claude Code not installed",
  });

  // Check for Codex
  const codexInstalled = commandExists("codex");
  const codexLaunchable = codexInstalled && process.env.YGOSIM_ALLOW_AGENT_LAUNCH === "1";
  agents.push({
    kind: "codex",
    installed: codexInstalled,
    launchable: codexLaunchable,
    connectCommand: codexInstalled
      ? `codex mcp add ygosim "node ${mpcPath}"`
      : "Codex not installed",
  });

  // Bot is always available
  agents.push({
    kind: "bot",
    installed: true,
    launchable: true,
    connectCommand: "Built-in AI opponent",
  });

  return agents;
}

export async function launchAgent(
  mpcPath: string,
  agent: AgentKind,
  roomId: string,
  seat: number = 1,
): Promise<{ ok: boolean; pid?: number; error?: string }> {
  if (agent === "bot") {
    return { ok: true }; // Bot doesn't need to be launched
  }

  if (!process.env.YGOSIM_ALLOW_AGENT_LAUNCH) {
    return { ok: false, error: "Agent launch disabled (set YGOSIM_ALLOW_AGENT_LAUNCH=1)" };
  }

  const procKey = `${roomId}:${seat}`;

  if (agentProcesses.has(procKey)) {
    return { ok: false, error: `Agent already running for ${procKey}` };
  }

  try {
    const prompt = `Join ygosim room ${roomId} (seat ${seat}) and play the duel to the end using the ygosim tools.`;
    let child: ChildProcess;

    if (agent === "claude") {
      if (!commandExists("claude")) {
        return { ok: false, error: "Claude Code not installed" };
      }

      child = spawn("claude", [
        "-p",
        prompt,
        "--mcp-config",
        mpcPath,
        "--allowedTools",
        "mcp__ygosim__*",
      ]);
    } else if (agent === "codex") {
      if (!commandExists("codex")) {
        return { ok: false, error: "Codex not installed" };
      }

      child = spawn("codex", [
        "exec",
        "--skip-git-repo-check",
        `-c`,
        `mcp_servers.ygosim.command="node"`,
        `mcp_servers.ygosim.args='["${mpcPath}"]'`,
        `-p`,
        prompt,
      ]);
    } else {
      return { ok: false, error: `Unknown agent: ${agent}` };
    }

    // Set environment for agent

    agentProcesses.set(procKey, { process: child, kind: agent, roomId, seat });

    return { ok: true, pid: child.pid };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function stopAgent(roomId: string, seat: number = 1): void {
  const procKey = `${roomId}:${seat}`;
  const proc = agentProcesses.get(procKey);
  if (proc) {
    try {
      proc.process.kill("SIGTERM");
      setTimeout(() => proc.process.kill("SIGKILL"), 5000);
    } catch {
      // Process already dead
    }
    agentProcesses.delete(procKey);
  }
}

export function stopRoomAgents(roomId: string): void {
  for (const [key] of agentProcesses) {
    if (key.startsWith(roomId + ":")) {
      const proc = agentProcesses.get(key);
      if (proc) {
        try {
          proc.process.kill("SIGTERM");
          setTimeout(() => proc.process.kill("SIGKILL"), 5000);
        } catch {
          // Process already dead
        }
      }
      agentProcesses.delete(key);
    }
  }
}
