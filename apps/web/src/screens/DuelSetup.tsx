import { useEffect, useState } from "react";
import type { AgentKind, MatchType } from "@ygosim/protocol";
import { listAgents, type AgentInfo } from "../api";
import { prefFormat, setPrefFormat } from "../deck";
import type { DeckProfile } from "../decks/store";
import type { DuelLaunch } from "../duel/DuelScreen";
import { Modal, useFormats } from "../ui/kit";

export type SetupMode = "agent" | "bot" | "watch" | "create";
type Level = "easy" | "normal" | "hard";

const AGENT_NAME: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex", bot: "Built-in Bot" };
const TITLE: Record<SetupMode, [string, string]> = {
  agent: ["Duel your Agent", "Your coding agent joins as the opponent."],
  bot: ["Solo vs Bot", "A quick duel against the built-in bot."],
  watch: ["Agent plays for you", "Your agent pilots your deck. You watch."],
  create: ["Create Room", "Share the code with a friend or an agent."],
};

export function DuelSetup({ mode, deck, onClose, onStart }: { mode: SetupMode; deck: DeckProfile; onClose: () => void; onStart: (l: DuelLaunch) => void }) {
  const formats = useFormats();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agent, setAgent] = useState<AgentKind>(mode === "bot" ? "bot" : "claude");
  const [rival, setRival] = useState<AgentKind>("bot");
  const [level, setLevel] = useState<Level>("normal");
  const [format, setFormat] = useState(prefFormat());
  const [match, setMatch] = useState<MatchType>("single");
  useEffect(() => { listAgents().then(setAgents); }, []);

  const info = (k: AgentKind) => agents.find((a) => a.agent === k);
  const fmt = formats.find((f) => f.id === format);
  const start = () => {
    setPrefFormat(format);
    const rules = { format, match };
    if (mode === "bot") return onStart({ mode: "ai", level, ...rules });
    if (mode === "create") return onStart({ mode: "create", ...rules });
    if (mode === "agent") return onStart({ mode: "agent", agent, launch: !!info(agent)?.launchable, ...rules });
    return onStart({ mode: "watch", agent, rival, level, launch: !!info(agent)?.launchable, ...rules });
  };

  const AgentPick = ({ value, set, allowBot }: { value: AgentKind; set: (k: AgentKind) => void; allowBot?: boolean }) => (
    <div className="opponents">
      {(["claude", "codex", ...(allowBot ? ["bot" as const] : [])] as AgentKind[]).map((k) => {
        const i = info(k);
        return (
          <button key={k} className={`opp${value === k ? " on" : ""}`} onClick={() => set(k)}>
            <b>{AGENT_NAME[k]}</b>
            {k === "bot"
              ? <small>Instant, no setup.</small>
              : <span className={`chip ${i?.launchable ? "ok" : i?.installed ? "gold" : ""}`}>{i?.launchable ? "Auto-launch" : i?.installed ? "Installed" : "Connect manually"}</span>}
          </button>
        );
      })}
    </div>
  );

  return (
    <Modal title={TITLE[mode][0]} subtitle={TITLE[mode][1]} onClose={onClose}
      footer={<>
        <span className="muted">Deck: <b style={{ color: "var(--text)" }}>{deck.name}</b></span>
        <span className="spacer" />
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" onClick={start}>{mode === "create" ? "Create" : "Start Duel"}</button>
      </>}>
      {mode === "agent" && <div className="field"><span>Opponent</span><AgentPick value={agent} set={setAgent} /></div>}
      {mode === "watch" && <>
        <div className="field"><span>Your pilot</span><AgentPick value={agent} set={setAgent} /></div>
        <div className="field"><span>Against</span><AgentPick value={rival} set={setRival} allowBot /></div>
      </>}
      {(mode === "bot" || (mode === "watch" && rival === "bot")) && (
        <div className="field"><span>Bot strength</span>
          <div className="seg">{(["easy", "normal", "hard"] as Level[]).map((l) => <button key={l} className={level === l ? "on" : ""} onClick={() => setLevel(l)} style={{ textTransform: "capitalize" }}>{l}</button>)}</div>
        </div>
      )}
      <div className="row" style={{ gap: 16, alignItems: "flex-start" }}>
        <label className="field" style={{ flex: 1 }}><span>Format</span>
          <select value={format} onChange={(e) => setFormat(e.target.value)}>{formats.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
          {fmt && <small>{fmt.startingLp} LP · {fmt.startingHand}-card hand · Main {fmt.deck.mainMin}–{fmt.deck.mainMax}</small>}
        </label>
        <div className="field"><span>Match</span>
          <div className="seg"><button className={match === "single" ? "on" : ""} onClick={() => setMatch("single")}>Single</button><button className={match === "match" ? "on" : ""} onClick={() => setMatch("match")}>Best of 3</button></div>
        </div>
      </div>
    </Modal>
  );
}
