import { useEffect, useState } from "react";
import type { AgentKind } from "@ygosim/protocol";
import { launchAgent, listAgents, type AgentInfo } from "../api";
import { useCopy } from "../ui/kit";
import type { DuelLaunch } from "./DuelScreen";

const NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", bot: "Bot" };

/** Lobby shown while the room waits for a coding agent (or a friend) to connect. */
export function AgentWaiting({ roomId, launch, players, agents, error, onExit }: {
  roomId: string; launch: DuelLaunch; players: string[];
  agents: Partial<Record<number, { agent: string; status: string; detail?: string }>>; error?: string; onExit: () => void;
}) {
  const [infos, setInfos] = useState<AgentInfo[]>([]);
  const [copied, copy] = useCopy();
  const [launching, setLaunching] = useState<string | null>(null);
  const [launchErr, setLaunchErr] = useState<string | null>(null);
  useEffect(() => { listAgents().then(setInfos); }, []);

  const wanted: AgentKind[] = launch.mode === "agent" || launch.mode === "watch" ? [launch.agent] : ["claude", "codex"];
  const seat = launch.mode === "watch" ? 0 : 1;
  const prompt = `Join ygosim room ${roomId} with the ygosim MCP tools and play the duel to the end. Read each prompt carefully and try to win.`;

  const doLaunch = async (k: AgentKind) => {
    setLaunching(k); setLaunchErr(null);
    const r = await launchAgent(roomId, k, seat);
    if (!r.ok) setLaunchErr(r.error ?? "Launch failed");
    setLaunching(null);
  };

  return (
    <div className="waiting">
      <div className="waiting-card">
        <div>
          <span className="eyebrow">{launch.mode === "create" ? "Room created" : "Waiting for your agent"}</span>
          <h1>Room <span className="room-code">{roomId}</span></h1>
          <p className="muted">{players.length} / 2 seated{players.length ? ` · ${players.join(", ")}` : ""}. The duel starts as soon as both seats are filled.</p>
        </div>
        <div className={`agent-row${wanted.length === 1 ? " single" : ""}`}>
          {wanted.map((k) => {
            const info = infos.find((i) => i.agent === k);
            const st = Object.values(agents).find((a) => a?.agent === k);
            const live = st?.status === "connected" || st?.status === "thinking";
            const cmd = (info?.connectCommand ?? "").replace(/<ROOM>/g, roomId);
            return (
              <div key={k} className={`agent-box${live ? " live" : ""}`}>
                <h3><span className={`dot ${live ? "on" : st?.status === "launching" ? "busy" : st?.status === "error" ? "bad" : ""}`} />{NAME[k]}<span className="spacer" /><span className="chip">{st?.status ?? "not connected"}</span></h3>
                {info?.launchable && (
                  <button className="primary" disabled={!!launching || live} onClick={() => doLaunch(k)}>{launching === k ? "Launching…" : live ? "Connected" : `Launch ${NAME[k]}`}</button>
                )}
                <ol>
                  <li>Add the YGOSim tools (once):</li>
                </ol>
                <button className="cmd" onClick={() => copy(cmd)} title="Click to copy">{copied === cmd ? "Copied ✓" : cmd || "Start the server to get the command"}</button>
                <ol start={2}><li>Then tell {NAME[k]}:</li></ol>
                <button className="cmd" onClick={() => copy(prompt)} title="Click to copy">{copied === prompt ? "Copied ✓" : prompt}</button>
                {st?.detail && <small className="muted">{st.detail}</small>}
              </div>
            );
          })}
        </div>
        {(launchErr || error) && <div className="unresolved">{launchErr ?? error}</div>}
        <div className="row"><button className="ghost" onClick={onExit}>← Leave room</button><span className="spacer" /><span className="muted">Full guide: docs/AGENTS.md</span></div>
      </div>
    </div>
  );
}
