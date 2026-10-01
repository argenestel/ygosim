import { useEffect, useState } from "react";
import { cropUrl, listRooms, type RoomInfo } from "../api";
import { activeProfile, coverOf, onDecksChanged, type DeckProfile } from "../decks/store";
import type { DuelLaunch } from "../duel/DuelScreen";
import { Modal } from "../ui/kit";
import { DuelSetup, type SetupMode } from "./DuelSetup";

export function Home({ onPlay, onDecks, onEdit }: { onPlay: (l: DuelLaunch) => void; onDecks: () => void; onEdit: (id: string) => void }) {
  const [deck, setDeck] = useState<DeckProfile | undefined>(activeProfile());
  const [setup, setSetup] = useState<SetupMode | null>(null);
  const [online, setOnline] = useState(false);
  useEffect(() => onDecksChanged(() => setDeck(activeProfile())), []);
  const cover = deck ? coverOf(deck) : undefined;
  const art = (code: number) => ({ ["--art" as string]: `url(${cropUrl(code)})` });

  return (
    <div className="home">
      <div>
        <div className="home-title">
          <h1>Duel your <em>agent.</em></h1>
          <p>Every TCG and OCG card, real rules. Pit yourself against Claude Code or Codex, or let them duel for you.</p>
        </div>
        <div className="modes">
          <button className="mode hero" style={art(46986414)} onClick={() => setSetup("agent")}>
            <span className="tag chip gold">Recommended</span>
            <span className="eyebrow">Versus</span>
            <h3>Duel your Agent</h3>
            <p>Your Claude Code or Codex joins as the opponent and plays every decision through the YGOSim tools.</p>
          </button>
          <button className="mode" style={art(89631139)} onClick={() => setSetup("bot")}>
            <span className="eyebrow">Practice</span>
            <h3>Solo vs Bot</h3>
            <p>Instant duel against the built-in bot.</p>
          </button>
          <button className="mode" style={art(44508094)} onClick={() => setSetup("watch")}>
            <span className="eyebrow">Spectate</span>
            <h3>Agent plays for you</h3>
            <p>Hand your deck to an agent and watch it duel.</p>
          </button>
          <button className="mode" style={art(84013237)} onClick={() => setOnline(true)}>
            <span className="eyebrow">Online</span>
            <h3>Room Duel</h3>
            <p>Create or join a room with a code.</p>
          </button>
        </div>
      </div>

      <aside className="deck-card">
        <div className="cover" style={cover ? { backgroundImage: `url(${cropUrl(cover)})` } : undefined} />
        <div className="body">
          <span className="eyebrow">Your deck</span>
          <h2>{deck?.name ?? "No deck"}</h2>
          {deck && <div className="counts"><span><b>{deck.deck.main.length}</b> Main</span><span><b>{deck.deck.extra.length}</b> Extra</span><span><b>{deck.deck.side.length}</b> Side</span></div>}
          <div className="row">
            <button onClick={onDecks} style={{ flex: 1 }}>Change deck</button>
            {deck && <button onClick={() => onEdit(deck.id)} style={{ flex: 1 }}>Edit</button>}
          </div>
        </div>
      </aside>

      {setup && deck && <DuelSetup mode={setup} deck={deck} onClose={() => setSetup(null)} onStart={(l) => { setSetup(null); onPlay(l); }} />}
      {online && <OnlineRooms onClose={() => setOnline(false)} onPlay={(l) => { setOnline(false); onPlay(l); }} onCreate={() => { setOnline(false); setSetup("create"); }} />}
    </div>
  );
}

function OnlineRooms({ onClose, onPlay, onCreate }: { onClose: () => void; onPlay: (l: DuelLaunch) => void; onCreate: () => void }) {
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [code, setCode] = useState("");
  useEffect(() => {
    let alive = true;
    const poll = () => listRooms().then((r) => alive && setRooms(r));
    poll();
    const t = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const open = rooms.filter((r) => r.status === "waiting");
  const live = rooms.filter((r) => r.status === "dueling");
  return (
    <Modal title="Room Duel" subtitle="Play a friend, or watch a duel in progress." onClose={onClose}
      footer={<><button className="ghost" onClick={onClose}>Close</button><span className="spacer" /><button className="primary" onClick={onCreate}>Create room</button></>}>
      <div className="field">
        <span>Join with a code</span>
        <div className="row">
          <input style={{ flex: 1 }} placeholder="Room code" value={code} onChange={(e) => setCode(e.target.value.trim())} onKeyDown={(e) => e.key === "Enter" && code && onPlay({ mode: "join", roomId: code })} />
          <button disabled={!code} onClick={() => onPlay({ mode: "join", roomId: code })}>Join</button>
        </div>
      </div>
      <div className="field">
        <span>Open rooms</span>
        {open.length === 0 && <small>No open rooms right now.</small>}
        {open.map((r) => (
          <button key={r.roomId} className="row" style={{ justifyContent: "space-between" }} onClick={() => onPlay({ mode: "join", roomId: r.roomId })}>
            <b>{r.roomId}</b><span className="muted">{r.players.join(" vs ")}</span><span className="chip">{r.format ?? "tcg"}{r.match === "match" ? " · Bo3" : ""}</span>
          </button>
        ))}
      </div>
      {live.length > 0 && (
        <div className="field">
          <span>Live duels</span>
          {live.map((r) => (
            <button key={r.roomId} className="row" style={{ justifyContent: "space-between" }} onClick={() => onPlay({ mode: "spectate", roomId: r.roomId })}>
              <b>{r.roomId}</b><span className="muted">{r.players.join(" vs ")}</span><span className="chip">Watch</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
