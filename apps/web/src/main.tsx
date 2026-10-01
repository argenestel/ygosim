import { createRoot } from "react-dom/client";
import { lazy, Suspense, useEffect, useState } from "react";
import { cropUrl } from "./api";
import { playerName, setPlayerName } from "./deck";
import { activeProfile, coverOf, onDecksChanged } from "./decks/store";
import type { DuelLaunch } from "./duel/DuelScreen";
import { DeckEditor } from "./screens/DeckEditor";
import { DeckList } from "./screens/DeckList";
import { Home } from "./screens/Home";
import "./styles.css";

// The 3D duel (three.js) is split out so the menus load instantly.
const DuelScreen = lazy(() => import("./duel/DuelScreen").then((m) => ({ default: m.DuelScreen })));

type Screen = { s: "home" } | { s: "decks" } | { s: "edit"; id: string } | { s: "duel"; launch: DuelLaunch; key: number };

function App() {
  const [screen, setScreen] = useState<Screen>({ s: "home" });
  const [name, setName] = useState(playerName());
  const [cover, setCover] = useState(() => { const p = activeProfile(); return p ? coverOf(p) : undefined; });
  useEffect(() => onDecksChanged(() => { const p = activeProfile(); setCover(p ? coverOf(p) : undefined); }), []);

  if (screen.s === "edit") return <DeckEditor id={screen.id} onBack={() => setScreen({ s: "decks" })} />;
  if (screen.s === "duel") {
    return (
      <Suspense fallback={<div className="duel-wait"><div className="spinner" /><h2>Entering the arena…</h2></div>}>
        <DuelScreen key={screen.key} launch={screen.launch} deck={activeProfile()?.deck ?? { main: [], extra: [], side: [] }} name={name} onExit={() => setScreen({ s: "home" })} />
      </Suspense>
    );
  }

  return (
    <div className="shell">
      <div className="shell-bg">{cover && <img src={cropUrl(cover)} alt="" />}</div>
      <header className="topbar">
        <div className="brand"><i />YGO<b>SIM</b></div>
        <nav className="nav">
          <button className={screen.s === "home" ? "on" : ""} onClick={() => setScreen({ s: "home" })}>Duel</button>
          <button className={screen.s === "decks" ? "on" : ""} onClick={() => setScreen({ s: "decks" })}>Decks</button>
        </nav>
        <span className="spacer" />
        <label className="player-pill" title="Your duelist name">
          <span className="avatar">{(name || "D")[0].toUpperCase()}</span>
          <input value={name} maxLength={24} onChange={(e) => { setName(e.target.value); setPlayerName(e.target.value || "Duelist"); }} />
        </label>
      </header>
      <main className="page">
        {screen.s === "home" && <Home onPlay={(launch) => setScreen({ s: "duel", launch, key: Date.now() })} onDecks={() => setScreen({ s: "decks" })} onEdit={(id) => setScreen({ s: "edit", id })} />}
        {screen.s === "decks" && <DeckList onEdit={(id) => setScreen({ s: "edit", id })} />}
      </main>
    </div>
  );
}

// No StrictMode: its double-mount would open two duel sockets.
createRoot(document.getElementById("root")!).render(<App />);
