import { execSync, spawn, type ChildProcess } from "node:child_process";
import type { AgentKind, AgentStatus } from "@ygosim/protocol";

export interface AgentInfo {
  agent: AgentKind;
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

export function getAgentInfo(mcpPath: string, port = Number(process.env.PORT ?? 7777)): AgentInfo[] {
  // Quote paths only when needed, preserving a separate executable and argument.
  const pathArg = /^[a-zA-Z0-9_./-]+$/.test(mcpPath)
    ? mcpPath : `'${mcpPath.replaceAll("'", "'\\''")}'`;
  return (["claude", "codex"] as const).map(agent => {
    const installed = commandExists(agent);
    const envFlag = agent === "claude" ? "-e" : "--env";
    return {
      agent,
      installed,
      launchable: installed && process.env.YGOSIM_ALLOW_AGENT_LAUNCH === "1",
      connectCommand: `${agent} mcp add ygosim ${agent === "codex" ? `-c 'mcp_servers.ygosim.default_tools_approval_mode="approve"' -c mcp_servers.ygosim.tool_timeout_sec=660 ` : ""}${envFlag} YGOSIM_URL=ws://localhost:${port} -- node ${pathArg}`,
    };
  });
}

export async function launchAgent(
  mpcPath: string,
  agent: AgentKind,
  roomId: string,
  seat: number = 1,
  port = Number(process.env.PORT ?? 7777),
): Promise<{ ok: boolean; pid?: number; error?: string }> {
  if (agent === "bot") {
    return { ok: true }; // Bot doesn't need to be launched
  }

  if (process.env.YGOSIM_ALLOW_AGENT_LAUNCH !== "1") {
    return { ok: false, error: "Agent launch disabled (set YGOSIM_ALLOW_AGENT_LAUNCH=1)" };
  }

  const procKey = `${roomId}:${seat}`;

  if (agentProcesses.has(procKey)) {
    return { ok: false, error: `Agent already running for ${procKey}` };
  }

  try {
    const prompt = `Join ygosim room ${roomId} (seat ${seat}) and play the duel to the end using the ygosim tools.`;
    const options = { env: { ...process.env, YGOSIM_URL: `ws://localhost:${port}` }, stdio: "ignore" as const };
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
      ], options);
    } else if (agent === "codex") {
      if (!commandExists("codex")) {
        return { ok: false, error: "Codex not installed" };
      }

      child = spawn("codex", [
        "exec",
        "--skip-git-repo-check",
        "-s", "read-only",
        "-c", 'mcp_servers.ygosim.command="node"',
        "-c", `mcp_servers.ygosim.args=${JSON.stringify([mpcPath])}`,
        "-c", 'mcp_servers.ygosim.default_tools_approval_mode="approve"',
        "-c", "mcp_servers.ygosim.tool_timeout_sec=660",
        prompt,
      ], options);
    } else {
      return { ok: false, error: `Unknown agent: ${agent}` };
    }

    // Set environment for agent

    agentProcesses.set(procKey, { process: child, kind: agent, roomId, seat });
    const release = () => {
      if (agentProcesses.get(procKey)?.process === child) agentProcesses.delete(procKey);
    };
    child.once("exit", release);
    child.once("error", release);

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
      const timer = setTimeout(() => { if (proc.process.exitCode === null && proc.process.signalCode === null) proc.process.kill("SIGKILL"); }, 5000);
      timer.unref();
      proc.process.once("exit", () => clearTimeout(timer));
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
          const timer = setTimeout(() => { if (proc.process.exitCode === null && proc.process.signalCode === null) proc.process.kill("SIGKILL"); }, 5000);
          timer.unref();
          proc.process.once("exit", () => clearTimeout(timer));
        } catch {
          // Process already dead
        }
      }
      agentProcesses.delete(key);
    }
  }
}
