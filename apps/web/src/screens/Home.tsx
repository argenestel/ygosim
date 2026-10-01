import { useEffect, useState } from "react";
import type { Format, MatchType } from "@ygosim/protocol";
import { isMock, listFormats, listPresetDecks, listRooms, type PresetDeck, type RoomInfo } from "../api";
import { activeDeckName, loadDecks, playerName, prefFormat, saveDecks, setActiveDeck, setPlayerName, setPrefFormat } from "../deck";
import type { DuelLaunch } from "../duel/DuelScreen";

export function Home({ onPlay, onDecks }: { onPlay: (l: DuelLaunch) => void; onDecks: () => void }) {
  const [name, setName] = useState(playerName());
  const [decks, setDecks] = useState(loadDecks());
  const [deckName, setDeckName] = useState(activeDeckName());
  const [level, setLevel] = useState<"easy" | "normal" | "hard">("normal");
  const [code, setCode] = useState("");
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [presets, setPresets] = useState<PresetDeck[]>([]);
  const [formats, setFormats] = useState<Format[]>([]);
  const [format, setFormat] = useState(prefFormat());
  const [match, setMatch] = useState<MatchType>("single");

  useEffect(() => {
    let alive = true;
    const poll = () => listRooms().then((r) => alive && setRooms(r));
    poll();
    const t = setInterval(poll, 4000);
    listPresetDecks().then((p) => alive && setPresets(p));
    listFormats().then((f) => alive && setFormats(f));
    return () => { alive = false; clearInterval(t); };
  }, []);

  const importPreset = (p: PresetDeck) => {
    const next = { ...decks, [p.name]: p.deck };
    saveDecks(next); setDecks(next); setDeckName(p.name); setActiveDeck(p.name);
  };
  const go = (l: DuelLaunch) => {
    setPlayerName(name || "Duelist"); setActiveDeck(deckName); setPrefFormat(format);
    onPlay(l.mode === "join" ? l : { ...l, format, match });
  };
  const fmt = formats.find((f) => f.id === format);
  const mcpCmd = `claude mcp add ygosim --env YGOSIM_URL=${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:7777 -- node <repo>/packages/mcp/dist/index.js`;

  return (
    <div className="home">
      <header className="hero">
        <div className="logo-mark" />
        <h1>YGO<span>SIM</span></h1>
        <p>Fan-made duel simulator · every card · play yourself or let your AI agent duel for you</p>
        {isMock && <p className="pill">Demo mode — scripted offline duel</p>}
      </header>

      <div className="home-grid">
        <section className="panel">
          <h2>Duelist</h2>
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} /></label>
          <label>Deck
            <select value={deckName} onChange={(e) => setDeckName(e.target.value)}>
              {Object.keys(decks).map((d) => <option key={d}>{d}</option>)}
            </select>
          </label>
          <div className="row">
            <button className="ghost" onClick={onDecks}>Deck Builder</button>
            {presets.length > 0 && (
              <select defaultValue="" onChange={(e) => { const p = presets.find((x) => x.name === e.target.value); if (p) importPreset(p); }}>
                <option value="" disabled>Import sample deck…</option>
                {presets.map((p) => <option key={p.name}>{p.name}</option>)}
              </select>
            )}
          </div>
        </section>

        <section className="panel">
          <h2>Rules</h2>
          <label>Format
            <select value={format} onChange={(e) => setFormat(e.target.value)}>
              {formats.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
          {fmt && <p className="muted fmt-desc">{fmt.description} · {fmt.startingLp} LP · {fmt.startingHand}-card hand</p>}
          <div className="seg">
            <button className={match === "single" ? "on" : ""} onClick={() => setMatch("single")}>Single duel</button>
            <button className={match === "match" ? "on" : ""} onClick={() => setMatch("match")}>Match (Bo3)</button>
          </div>
        </section>

        <section className="panel feature">
          <h2>Duel the AI</h2>
          <div className="seg">
            {(["easy", "normal", "hard"] as const).map((l) => <button key={l} className={level === l ? "on" : ""} onClick={() => setLevel(l)}>{l}</button>)}
          </div>
          <button className="primary big" onClick={() => go({ mode: "ai", level })}>Start Duel</button>
        </section>

        <section className="panel">
          <h2>Online room</h2>
          <button className="primary" onClick={() => go({ mode: "create" })}>Create room</button>
          <div className="row">
            <input placeholder="Room code" value={code} onChange={(e) => setCode(e.target.value.trim())} />
            <button disabled={!code} onClick={() => go({ mode: "join", roomId: code })}>Join</button>
          </div>
          <div className="rooms">
            {rooms.length === 0 && <p className="muted">No open rooms</p>}
            {rooms.map((r) => (
              <button key={r.roomId} className="room" disabled={r.status !== "waiting"} onClick={() => go({ mode: "join", roomId: r.roomId })}>
                <b>{r.roomId}</b><span>{r.players.join(" vs ") || "—"}</span><em>{[r.format, r.match === "match" ? "Bo3" : "", r.status].filter(Boolean).join(" · ")}</em>
              </button>
            ))}
          </div>
        </section>

        <section className="panel agent">
          <h2>Let your agent play</h2>
          <p>Connect Claude Code, Codex or any MCP-capable agent. It can create a room against the AI, or join a room you created, then duel turn by turn.</p>
          <code className="cmd" onClick={() => navigator.clipboard?.writeText(mcpCmd)} title="Click to copy">{mcpCmd}</code>
          <p className="muted">Then ask it: <i>"Create a ygosim room vs the hard AI and win the duel."</i> Full setup, including Codex, is in <b>docs/AGENTS.md</b>.</p>
        </section>
      </div>
      <footer>Unofficial fan project. Not affiliated with or endorsed by Konami. Card images are loaded from a public card database.</footer>
    </div>
  );
}
